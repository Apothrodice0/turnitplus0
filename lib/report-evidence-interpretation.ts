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
import type { UnifiedEvidenceContribution } from "@/lib/unified-similarity";
import { compactUnifiedSimilarityForPersistence } from "@/lib/unified-similarity-persistence";
import {
  compactEvidenceInterpretationForPersistence,
  type PersistedEvidenceInterpretation,
} from "@/lib/evidence-interpretation/persistence";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "@/lib/report-transport-limits";
import { resolveCompactPersistenceWrites } from "@/lib/report-compact-persistence-flag";

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
 * IMPORTED SIMILARITY EVIDENCE V1 — the customer-facing explanation link this
 * channel was missing: derives the same `{key, spans, sourceAttributionState}[]`
 * shape buildReportEvidenceInterpretation's normalizeImportedSimilarityEvidence
 * adapter already expects (lib/evidence-interpretation/adapters.ts), straight
 * from the per-passage attribution resolvePrimarySimilaritySummary already
 * wrote onto `report.unifiedSimilarity.contributions` (sourceType
 * "imported_similarity_evidence") when computeUnifiedSimilarity resolved this
 * channel — the SAME persisted data the score itself came from. No
 * re-verification, no new resolution, no second pipeline: purely a read +
 * group-by-sourceId of data already computed, exactly like
 * normalizePriorSubmissionEvidence already does for previousUploadPositions.
 * A unit matched at multiple occurrences contributes multiple entries with
 * the same sourceId here, correctly producing one card with multiple spans.
 *
 * Absent/empty contributions (no package configured, corrupt package, or no
 * match for this submission) yields `[]` —
 * normalizeImportedSimilarityEvidence's own empty-input behavior — so a
 * report with no imported evidence gets no card, byte-identical to before
 * this wiring existed.
 */
function admittedImportedSimilaritySources(
  report: SimilarityReport,
): NonNullable<BuildReportEvidenceInterpretationOptions["importedSimilarityAdmittedSources"]> {
  const byUnit = new Map<
    string,
    {
      spans: { start: number; end: number; words: number }[];
      sourceAttributionState?: UnifiedEvidenceContribution["importedSourceAttributionState"];
    }
  >();
  for (const c of report.unifiedSimilarity?.contributions ?? []) {
    if (c.sourceType !== "imported_similarity_evidence" || c.evidenceStatus !== "included") continue;
    let entry = byUnit.get(c.sourceId);
    if (!entry) {
      entry = { spans: [], sourceAttributionState: c.importedSourceAttributionState };
      byUnit.set(c.sourceId, entry);
    }
    entry.spans.push({ start: c.submittedWordStart, end: c.submittedWordEnd, words: c.matchedWordCount });
  }
  return [...byUnit.entries()].map(([key, v]) => ({
    key,
    spans: v.spans,
    sourceAttributionState: v.sourceAttributionState,
  }));
}

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
    importedSimilarityAdmittedSources: admittedImportedSimilaritySources(base as SimilarityReport),
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

export type FinalizedReportEvidenceInterpretationOptions = {
  /** The historical match the FINAL unifiedSimilarity was resolved with (POSSIBLE_SAME_WORK stays dormant, but this mirrors what the write-time path threads). */
  historicalSubmissionMatch?: ReportHistoricalSubmissionMatch | null;
  /**
   * The SERVER-VERIFIED user-supplied-reference evidence that FED the final
   * unifiedSimilarity — pass it only when the caller's score resolution
   * included that channel (as finalizeReportJson's does). Omitted (the
   * default) means the final score was resolved WITHOUT it — the authoritative
   * finalizer's deliberate boundary — so no reference card is produced for
   * evidence the score does not contain. Deliberately never inferred from the
   * report's own persisted userSuppliedReferenceEvidence: the explanation may
   * only describe inputs the score actually had.
   */
  userSuppliedReferenceEvidence?: readonly SuppliedReferenceVerifiedEvidence[] | null;
  /** Ceiling the ENCODED whole final report must fit. Defaults to the existing, unchanged MAX_REPORT_SAVE_REQUEST_BYTES — the same limit app/api/reports/route.ts's persisted-size checks enforce. */
  maxBytes?: number;
  /**
   * R2 write gate — pins whether the persisted form is compact. Omitted (the
   * production case) it follows REPORT_COMPACT_PERSISTENCE_WRITE_ENABLED (default
   * OFF => legacy). Resolved ONCE here and returned as `compactWrites`, so the size
   * this builder measures is the size the caller's write then persists.
   */
  compactWrites?: boolean;
};

/**
 * Outcome of preparing the authoritative finalizer's interpretation.
 *
 *   ok: true  — `evidenceInterpretation` is the PERSISTED-FORM (compact when compact
 *               writes are enabled and it is losslessly representable; otherwise
 *               the legacy full shape) interpretation of the final report, and the
 *               ENCODED whole final report fits the limit. Persist it — with the
 *               returned `compactWrites` — in the SAME atomic write as the final score.
 *   ok: false — the final score must NOT be persisted at all. There is no
 *               "persist the score and remove the explanation" outcome any more.
 *     BUILD_FAILED             the (pure) interpretation build threw / produced nothing.
 *     PERSISTED_SIZE_EXCEEDED  the encoded whole report (compact when compact writes are enabled) is over `maxBytes`.
 */
export type FinalizedReportInterpretationResult =
  | { ok: true; evidenceInterpretation: PersistedEvidenceInterpretation; compactWrites: boolean }
  | { ok: false; reason: "BUILD_FAILED" }
  | { ok: false; reason: "PERSISTED_SIZE_EXCEEDED"; persistedBytes: number; maxBytes: number };

/**
 * AUTHORITATIVE PROMOTION — the evidenceInterpretation for a report whose FINAL
 * unifiedSimilarity was just (re)computed OUTSIDE app/api/reports/route.ts's
 * write-time finalizeReportJson: today, lib/selective-corpus-authoritative.ts's
 * deferred pending -> terminal finalizer, whose raw json_set can only replace
 * whole keys of the already-persisted row. A report created while that mode is
 * on is persisted with NO unifiedSimilarity, so the interpretation POST built
 * for it was derived from archive-only positions and could never carry any
 * channel that only exists in the final score (imported evidence, Selective
 * Corpus). This derives it from THAT FINAL report instead, through the very
 * same withEvidenceInterpretation call finalizeReportJson makes (never a second
 * builder) — pure, explanation only, no score or matched position changes.
 *
 * The interpretation is built from exactly the inputs that FED the final
 * score, so it can never explain evidence the score does not contain:
 * `finalReport` must carry the FINAL, fully-expanded unifiedSimilarity plus the
 * server-verified externalAcademicEvidence that fed it, and any
 * user-supplied-reference evidence the score was given is passed explicitly
 * through `opts` (see FinalizedReportEvidenceInterpretationOptions).
 *
 * C2 — FAIL CLOSED. This used to return null — "persist NO interpretation, and
 * remove any earlier one" — when building threw or the final report would not
 * fit, so the caller landed the NEW final score with its explanation deleted.
 * That outcome no longer exists: the result is either the persisted-form
 * interpretation together with proof the encoded whole report fits, or an
 * explicit failure, and on failure the caller must not write the score.
 *
 * The size check measures exactly what the CAS write persists: the whole
 * final report with its `unifiedSimilarity` (previousUploadPositions elision +,
 * when compact writes are enabled, compact contributions) and its
 * `evidenceInterpretation` (compact when enabled), against the unchanged
 * MAX_REPORT_SAVE_REQUEST_BYTES. R2: with compact writes OFF (the default) that
 * is the legacy form, so the fail-closed size behavior holds unchanged — an
 * explained report that does not fit is never persisted without its explanation.
 */
export function buildFinalizedReportEvidenceInterpretation(
  finalReport: SimilarityReport,
  opts: FinalizedReportEvidenceInterpretationOptions = {},
): FinalizedReportInterpretationResult {
  const maxBytes = opts.maxBytes ?? MAX_REPORT_SAVE_REQUEST_BYTES;
  const compactWrites = resolveCompactPersistenceWrites(opts);
  try {
    const interpretation = withEvidenceInterpretation(finalReport, {
      historicalSubmissionMatch: opts.historicalSubmissionMatch ?? null,
      selectiveCorpusBranch: null,
      userSuppliedReferenceEvidence: opts.userSuppliedReferenceEvidence ?? null,
    }).evidenceInterpretation;
    if (!interpretation) return { ok: false, reason: "BUILD_FAILED" };
    const persistedInterpretation = compactEvidenceInterpretationForPersistence(interpretation, { compactWrites });
    const persisted = {
      ...finalReport,
      ...(finalReport.unifiedSimilarity
        ? { unifiedSimilarity: compactUnifiedSimilarityForPersistence(finalReport.unifiedSimilarity, { compactWrites }) }
        : {}),
      evidenceInterpretation: persistedInterpretation,
    };
    const persistedBytes = JSON.stringify(persisted).length;
    if (persistedBytes > maxBytes) return { ok: false, reason: "PERSISTED_SIZE_EXCEEDED", persistedBytes, maxBytes };
    return { ok: true, evidenceInterpretation: persistedInterpretation, compactWrites };
  } catch (err) {
    console.error(
      "report V2 finalized-report interpretation build failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "BUILD_FAILED" };
  }
}

/**
 * AUTHORITATIVE PROMOTION — refreshes ONLY reportCompletion's selectiveCorpus
 * signal from the report's own persisted selectiveCorpusAuthoritativeStatus.
 * Called at RESPONSE time (GET / SSR first paint), never at write time: the
 * deferred finalizer's own CAS-guarded terminal write
 * (persistSelectiveCorpusAuthoritativeFinalization) replaces unifiedSimilarity
 * and — atomically, in that same statement, see
 * buildFinalizedReportEvidenceInterpretation above — evidenceInterpretation,
 * plus its own generation+flag snapshot / the status marker itself, but
 * deliberately never reportCompletion — so a report's persisted
 * reportCompletion still reflects whatever selectiveCorpusBranch was true at
 * the ORIGINAL pending-branch save (always null there, since the search had
 * not run yet). This is the one place that goes stale without a response-time
 * refresh; nothing else about reportCompletion needs one.
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
