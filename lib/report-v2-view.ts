import {
  primaryMatchedWordCount,
  primarySimilarityScore,
  unifiedMatchedPositions,
  type SimilarityReport,
  type UncertainEvidenceReason,
} from "@/lib/report-types";
import type {
  ReportEvidenceInterpretation,
  ReportEvidenceNamedSource,
  ReportEvidencePassage,
  ReportEvidenceSource,
} from "@/lib/evidence-interpretation/report-payload-types";
import {
  completionDiagnosticsFromSignals,
  partialCompletionDetail,
  REPORT_COMPLETION_HEADLINE,
  SIMILARITY_NOT_FINALIZED_DETAIL,
  SIMILARITY_NOT_FINALIZED_HEADLINE,
  type ReportCompletion,
  type ReportCompletionDiagnostic,
} from "@/lib/evidence-interpretation/completion";
import type { ReportExtractionDiagnostic } from "@/lib/evidence-interpretation/extraction";
import { skippedUnitCount } from "@/lib/evidence-interpretation/extraction";
import type {
  EvidenceInterpretationConfidence,
  EvidenceInterpretationKind,
  EvidenceInterpretationTone,
} from "@/lib/evidence-interpretation/kinds";
import { EVIDENCE_INTERPRETATION_KINDS } from "@/lib/evidence-interpretation/kinds";
import { archiveSourceAccounting, archiveSourceCountLabel } from "@/lib/evidence-interpretation/archive-source-accounting";
import { reportScoringNormalizationVersion, tokenSpans, type ScoringNormalizationVersion } from "@/lib/similarity-core";

/**
 * REPORT V2 — pure view-model.
 *
 * Turns the additive, explanation-only `evidenceInterpretation` /
 * `reportCompletion` / `extractionDiagnostic` payload (see
 * lib/evidence-interpretation/ + lib/report-evidence-interpretation.ts) into the
 * exact shape the Report V2 UI renders. Adds NO score and recomputes NO matched
 * position:
 *   - `verifiedSimilarityPercent` is `primarySimilarityScore(report)` verbatim,
 *   - the kind breakdown is a disjoint re-slice of the SAME
 *     `evidenceInterpretation.countsByKind` (its own totals already reconcile
 *     exactly with the authoritative matched-word union),
 *   - passage char offsets come from `tokenSpans(report.text)` — the same
 *     word-index → character-offset geometry the existing highlighter uses.
 *
 * `buildReportV2ViewModel` returns `null` when `report.evidenceInterpretation`
 * is absent (an old report saved before the wiring) — the caller then renders
 * the existing report UI unchanged.
 *
 * COMMON_DEFINITION / COMMON_ACADEMIC_LANGUAGE never appear — the payload's six
 * kinds are the only vocabulary, and a span the interpreter would have put
 * there is already folded into DISTINCTIVE_EXTERNAL_MATCH upstream.
 */

// ── copy ─────────────────────────────────────────────────────────────────
export const KIND_SUMMARY_LABEL: Record<EvidenceInterpretationKind, string> = {
  DISTINCTIVE_EXTERNAL_MATCH: "Verified source overlap",
  ATTRIBUTED_QUOTATION: "Quoted — with attribution",
  DECLARED_QUOTATION: "Quoted — attribution not confirmed",
  LEGITIMATE_ALTERNATE_SOURCE: "Also in another verified source",
  POSSIBLE_SAME_WORK: "Possible same-work or prior-publication match",
  FAMILY_BOILERPLATE: "Repeated template / family wording",
};

export const KIND_PASSAGE_LABEL: Record<EvidenceInterpretationKind, string> = {
  DISTINCTIVE_EXTERNAL_MATCH: "Verified source overlap",
  ATTRIBUTED_QUOTATION: "Quoted passage with nearby attribution",
  DECLARED_QUOTATION: "Quoted passage — attribution not confirmed",
  LEGITIMATE_ALTERNATE_SOURCE: "Same text appears in another verified source",
  POSSIBLE_SAME_WORK: "Possible same-work or prior-publication match",
  FAMILY_BOILERPLATE: "Repeated template / family wording",
};

/** "What this means" — shown under the chip label and in the source-card expander. */
export const KIND_MEANING: Record<EvidenceInterpretationKind, string> = {
  DISTINCTIVE_EXTERNAL_MATCH:
    "This wording closely matches a specific source. Check whether it should be quoted, paraphrased, or cited.",
  ATTRIBUTED_QUOTATION:
    "This passage is in quotation marks and there is a citation or source name next to it.",
  DECLARED_QUOTATION:
    "This passage is in quotation marks, but we did not find a citation or source name next to it. Add one if it is a quotation.",
  LEGITIMATE_ALTERNATE_SOURCE:
    "The same passage was also found in another source you matched. It may simply have more than one valid source.",
  POSSIBLE_SAME_WORK:
    "A recorded work/version relationship links this source to your document — it may be the same work or an earlier version of it.",
  FAMILY_BOILERPLATE:
    "This is standard/template wording that also appears across several other reference documents, rather than distinctive copying.",
};

export const CONFIDENCE_LABEL: Record<EvidenceInterpretationConfidence, string> = {
  high: "confirmed word-for-word",
  medium: "likely",
  low: "possible",
};

export type ReportV2SourceType = ReportEvidenceSource["sourceType"];

export const SOURCE_TYPE_BADGE: Record<ReportV2SourceType, string> = {
  internet: "Internet source",
  publication: "Publication",
  "reference-collection": "TurnitPlus reference collection",
  "prior-submission": "TurnitPlus reference collection",
  "selective-corpus": "TurnitPlus reference collection",
  "user-supplied-reference": "Supplied reference",
  "imported-similarity-evidence": "Imported reference match",
};

/** Non-attributable buckets — no external link, no named document, ever. */
export function isGenericReferenceSource(sourceType: ReportV2SourceType): boolean {
  return (
    sourceType === "reference-collection" ||
    sourceType === "prior-submission" ||
    sourceType === "selective-corpus" ||
    sourceType === "imported-similarity-evidence"
  );
}

// UX cleanup: no provider brand names here — ordinary customers should only
// need to know TurnitPlus checked its reference collection and available
// live academic sources, not which providers those checks used. Provider
// names remain visible to admins elsewhere (components/report/similarity-
// report-papers.tsx's canSeeSourceBreakdown-gated copy) — this constant only
// controls the customer-facing Report V2 scope line.
export const COMPLETION_SCOPE_LINE =
  "Compared against TurnitPlus’s reference collection and available live academic sources. Exact Wikipedia phrase matches are listed separately and do not change this result.";

/**
 * The concise search-status label (toolbar, hero metric, print scope, receipt)
 * for each completion state — one mapping shared by every surface so the
 * browser, the printed report and the receipt never disagree. A partial search
 * is a precise, non-fatal state, never the vague "Needs attention".
 */
export const COMPLETION_STATUS_LABEL: Record<ReportCompletion["state"], string> = {
  COMPLETED: "Completed",
  PARTIAL: "Partial search",
  SOURCE_UNAVAILABLE: "Source not verified",
  EXTRACTION_PARTIAL: "Partial document",
};

/** The status label of a report that has no similarity result (see resolveCompletionView). */
export const SIMILARITY_UNAVAILABLE_STATUS_LABEL = "Similarity unavailable";

export function completionStatusLabel(state: ReportCompletion["state"]): string {
  return COMPLETION_STATUS_LABEL[state] ?? COMPLETION_STATUS_LABEL.PARTIAL;
}

// ── highlight legend copy ────────────────────────────────────────────────
// RED = verified source-text overlap that counts toward the headline.
// YELLOW = a possible match that does NOT count (SimilarityReport.uncertainEvidence).
// TurnitPlus's yellow means uncertainty — never "missing citation".
export const VERIFIED_MATCH_LEGEND = "Verified match — counted in the similarity score.";
export const UNCERTAIN_MATCH_LEGEND = "Possible match — source could not be fully verified; not counted in the similarity score.";

// ── filter taxonomy ──────────────────────────────────────────────────────
export type ReportV2Filter = "all" | "review" | "quotations" | "other";

export const FILTER_KINDS: Record<Exclude<ReportV2Filter, "all">, EvidenceInterpretationKind[]> = {
  review: ["DISTINCTIVE_EXTERNAL_MATCH", "POSSIBLE_SAME_WORK"],
  quotations: ["ATTRIBUTED_QUOTATION", "DECLARED_QUOTATION"],
  other: ["LEGITIMATE_ALTERNATE_SOURCE", "FAMILY_BOILERPLATE"],
};

export function filterOfKind(kind: EvidenceInterpretationKind): Exclude<ReportV2Filter, "all"> {
  if (FILTER_KINDS.review.includes(kind)) return "review";
  if (FILTER_KINDS.quotations.includes(kind)) return "quotations";
  return "other";
}

// ── view-model shape ─────────────────────────────────────────────────────
export type ReportV2BreakdownRow = {
  kind: EvidenceInterpretationKind;
  label: string;
  matchedWords: number;
  /** rounded share of the WHOLE document (denominator = report.wordCount). */
  percentOfDocument: number;
  /** share of the verified-overlap union — drives the stacked-bar width, always sums to ~100. */
  shareOfOverlap: number;
};

export type ReportV2TopSource = {
  id: string;
  label: string;
  sourceType: ReportV2SourceType;
  badge: string;
  contributionPercent: number;
  matchedWords: number;
  interpretationLabel: string;
  link: string | null;
};

export type ReportV2SourceCard = {
  id: string;
  label: string;
  sourceType: ReportV2SourceType;
  badge: string;
  isGeneric: boolean;
  link: string | null;
  doi: string | null;
  year: number | null;
  contributionPercent: number;
  matchedWords: number;
  primaryKind: EvidenceInterpretationKind;
  primaryLabel: string;
  meaning: string;
  confidence: EvidenceInterpretationConfidence;
  confidenceLabel: string;
  reasons: string[];
  mixedKindLabels: string[];
  passageRefs: number[];
  /** archive aggregate card only — the individual public-safe source names. */
  namedSources: ReportEvidenceNamedSource[];
};

export type ReportV2Passage = {
  id: number;
  wordStart: number;
  wordEnd: number;
  /** character offsets into `report.text`; null when the run falls outside the token span table. */
  charStart: number | null;
  charEnd: number | null;
  /** the student's own text for this run (from `report.text` when offsets resolved, else the payload excerpt). */
  highlightText: string;
  excerpt: string;
  kind: EvidenceInterpretationKind;
  label: string;
  meaning: string;
  tone: EvidenceInterpretationTone;
  confidence: EvidenceInterpretationConfidence;
  confidenceLabel: string;
  filter: Exclude<ReportV2Filter, "all">;
  sourceIds: string[];
};

export type ReportV2Completion = {
  state: ReportCompletion["state"];
  /** concise status label — completionStatusLabel(state). */
  statusLabel: string;
  headline: string;
  detail: string | null;
  /** true only for a genuine EXTRACTION_PARTIAL — never for completeness "UNKNOWN". */
  extractionPartial: boolean;
  scopeLine: string;
  signals: ReportCompletion["signals"];
  /** machine-readable channel + reason per contributing channel (admin diagnostics); empty for COMPLETED. */
  diagnostics: ReportCompletionDiagnostic[];
};

/** A possible (yellow, never scored) match run, resolved to character offsets in report.text. */
export type ReportV2UncertainPassage = {
  wordStart: number;
  wordEnd: number;
  charStart: number;
  charEnd: number;
  reason: UncertainEvidenceReason;
};

export type ReportV2ViewModel = {
  interpretationVersion: string;
  isUnified: boolean;
  headlineLabel: string;
  summary: {
    verifiedSimilarityPercent: number;
    matchedWordCount: number;
    totalWordCount: number;
    /** verified sources the evidence came from — an Archive card that stands
     *  for several documents counts as each of them (archiveSourceAccounting). */
    distinctVerifiedSources: number;
    /** true when the report only proves "at least" distinctVerifiedSources */
    distinctVerifiedSourcesIsLowerBound: boolean;
    completion: ReportV2Completion;
    topSources: ReportV2TopSource[];
    breakdown: ReportV2BreakdownRow[];
    /** present only when the interpreter folded common-definition / common-academic spans into DISTINCTIVE. */
    deferredNote: string | null;
  };
  sources: ReportV2SourceCard[];
  passages: ReportV2Passage[];
  /** yellow, NON-SCORING possible matches — never overlapping a verified word; empty for every report without uncertainEvidence. */
  uncertainPassages: ReportV2UncertainPassage[];
  filterCounts: Record<ReportV2Filter, number>;
  /** true when the document had matched positions but none produced a passage row. */
  hasPassages: boolean;
};

// ── completion copy ──────────────────────────────────────────────────────
// Exported so the legacy/full report views (components/report/similarity-
// report-papers.tsx) can surface the exact same customer-safe completion
// wording Report V2 uses, rather than duplicating this mapping.
export function resolveCompletionView(
  completion: ReportCompletion | undefined,
  extraction: ReportExtractionDiagnostic | undefined,
  verifiedSimilarityPercent: number,
): ReportV2Completion {
  const state = completion?.state ?? "COMPLETED";
  const extractionPartial = state === "EXTRACTION_PARTIAL" && (extraction?.completeness === "PARTIAL");

  // Prefer the server-authored headline/detail; fall back to deterministic copy
  // so a legacy/oddly-shaped completion object still renders sane, non-alarming
  // text (and never the EXTRACTION_PARTIAL wording when completeness is UNKNOWN).
  // PARTIAL is the exception: its copy is always the CURRENT partial-search
  // wording (verified lower bound; completed searches still count; unreachable
  // sources are not counted), so a report saved under the older, vaguer
  // "Some source searches were unavailable" copy reads the same as a new one.
  const effectiveState: ReportCompletion["state"] =
    state === "EXTRACTION_PARTIAL" && !extractionPartial ? "PARTIAL" : state;
  // The one PARTIAL completion that must keep the server's own copy: a report whose similarity result could not be stored
  // (lib/evidence-interpretation/completion.ts SIMILARITY_NOT_FINALIZED_HEADLINE). It has no score, so the partial-search
  // wording ("the N% shown is a verified lower bound") would be false. The headline is the server-authored marker of that
  // case — the reason code itself is admin-only and not in a customer's completion.
  const similarityNotFinalized = effectiveState === "PARTIAL" && completion?.headline === SIMILARITY_NOT_FINALIZED_HEADLINE;

  let detail = completion?.detail ?? null;
  if (effectiveState === "COMPLETED") detail = null;
  else if (similarityNotFinalized) detail = SIMILARITY_NOT_FINALIZED_DETAIL;
  else if (effectiveState === "PARTIAL") detail = partialCompletionDetail(verifiedSimilarityPercent);
  else if (!detail) {
    if (effectiveState === "SOURCE_UNAVAILABLE") {
      const n = Math.max(1, completion?.signals.unverifiedCandidateCount ?? 1);
      detail = `${n} possible source${n === 1 ? " is" : "s are"} listed separately as “identified, not verified” and ${n === 1 ? "is" : "are"} not included in the ${verifiedSimilarityPercent}%.`;
    } else if (effectiveState === "EXTRACTION_PARTIAL") {
      const skipped = extraction ? skippedUnitCount(extraction) : 0;
      const unit = extraction?.skipped?.unit ?? "sections";
      detail = skipped > 0
        ? `About ${skipped} ${unit} of the file could not be read and ${skipped === 1 ? "was" : "were"} skipped. Re-upload a text-based copy for a complete result.`
        : "Some of the file could not be read and was skipped. Re-upload a text-based copy for a complete result.";
    }
  }

  const signals: ReportCompletion["signals"] = completion?.signals ?? {
    academicSearch: null,
    selectiveCorpus: null,
    extraction: extraction?.completeness ?? "UNKNOWN",
    unverifiedCandidateCount: 0,
    userSuppliedReference: null,
  };
  return {
    state: effectiveState,
    statusLabel: similarityNotFinalized ? SIMILARITY_UNAVAILABLE_STATUS_LABEL : completionStatusLabel(effectiveState),
    headline: similarityNotFinalized
      ? SIMILARITY_NOT_FINALIZED_HEADLINE
      : effectiveState === "PARTIAL"
        ? REPORT_COMPLETION_HEADLINE.PARTIAL
        : completion?.headline?.trim() || REPORT_COMPLETION_HEADLINE[effectiveState],
    detail,
    extractionPartial,
    scopeLine: COMPLETION_SCOPE_LINE,
    signals,
    // A completion persisted before diagnostics existed: derived from its own
    // signals, every reason NOT_RECORDED — the channel is known, the cause is not.
    diagnostics: effectiveState === "COMPLETED" ? [] : completion?.diagnostics ?? completionDiagnosticsFromSignals(signals),
  };
}

/**
 * The verified word set a possible match must never overlap: the authoritative
 * unified matched positions, the archive positions (a report without
 * unifiedSimilarity), and every position the evidence interpretation explains.
 * Red always wins — a word that is verified anywhere is never painted yellow.
 */
function verifiedWordSet(report: SimilarityReport): Set<number> {
  const words = new Set<number>(unifiedMatchedPositions(report));
  for (const p of report.archiveMatchedPositions ?? []) words.add(p);
  const byKind = report.evidenceInterpretation?.positionsByKind;
  if (byKind) for (const positions of Object.values(byKind)) for (const p of positions ?? []) words.add(p);
  return words;
}

/**
 * Resolves report.uncertainEvidence into yellow runs: clipped to the report's
 * own token table (its scoring-normalization contract), with every verified
 * word removed (a passage that straddles verified text is split around it),
 * then merged and sorted. Pure presentation — reads no score and changes none.
 * [] for every report without uncertainEvidence (all reports today).
 */
export function resolveUncertainPassages(
  report: SimilarityReport,
  tokenSpanTable?: ReturnType<typeof tokenSpans>,
): ReportV2UncertainPassage[] {
  const passages = report.uncertainEvidence?.passages ?? [];
  if (passages.length === 0) return [];
  const spans = tokenSpanTable ?? tokenSpans(report.text ?? "", reportScoringNormalizationVersion(report));
  if (spans.length === 0) return [];
  const verified = verifiedWordSet(report);
  const reasonByWord = new Map<number, UncertainEvidenceReason>();
  for (const p of passages) {
    if (!Number.isInteger(p.wordStart) || !Number.isInteger(p.wordEnd) || p.wordEnd < p.wordStart) continue;
    const start = Math.max(0, p.wordStart);
    const end = Math.min(spans.length - 1, p.wordEnd);
    for (let w = start; w <= end; w += 1) {
      if (!verified.has(w) && !reasonByWord.has(w)) reasonByWord.set(w, p.reason);
    }
  }
  const words = [...reasonByWord.keys()].sort((a, b) => a - b);
  const runs: ReportV2UncertainPassage[] = [];
  for (const w of words) {
    const last = runs[runs.length - 1];
    const reason = reasonByWord.get(w)!;
    if (last && last.wordEnd === w - 1 && last.reason === reason) {
      last.wordEnd = w;
      last.charEnd = spans[w].end;
    } else {
      runs.push({ wordStart: w, wordEnd: w, charStart: spans[w].start, charEnd: spans[w].end, reason });
    }
  }
  return runs;
}

// ── passage geometry ─────────────────────────────────────────────────────
function passageCharRange(
  spans: ReturnType<typeof tokenSpans>,
  wordStart: number,
  wordEnd: number,
): { charStart: number | null; charEnd: number | null } {
  if (spans.length === 0 || wordStart < 0 || wordStart >= spans.length) {
    return { charStart: null, charEnd: null };
  }
  const endIdx = Math.min(wordEnd, spans.length - 1);
  if (endIdx < wordStart) return { charStart: null, charEnd: null };
  return { charStart: spans[wordStart].start, charEnd: spans[endIdx].end };
}

// ── main builder ─────────────────────────────────────────────────────────
export function buildReportV2ViewModel(report: SimilarityReport): ReportV2ViewModel | null {
  const ei: ReportEvidenceInterpretation | undefined = report.evidenceInterpretation;
  if (!ei) return null;

  const totalWordCount = Math.max(0, report.wordCount || 0);
  const verifiedSimilarityPercent = primarySimilarityScore(report);
  const matchedWordCount = ei.matchedWordCount;
  const denom = Math.max(1, totalWordCount);

  // breakdown — only kinds with matched words, largest first
  const breakdown: ReportV2BreakdownRow[] = EVIDENCE_INTERPRETATION_KINDS
    .map((kind) => {
      const matchedWords = ei.countsByKind[kind] ?? 0;
      return {
        kind,
        label: KIND_SUMMARY_LABEL[kind],
        matchedWords,
        percentOfDocument: Math.round((matchedWords / denom) * 100),
        shareOfOverlap: matchedWordCount > 0 ? Math.round((matchedWords / matchedWordCount) * 100) : 0,
      };
    })
    .filter((row) => row.matchedWords > 0)
    .sort((a, b) => b.matchedWords - a.matchedWords || a.kind.localeCompare(b.kind));

  // sources — already `src-N`, already sorted by id in the payload
  const sources: ReportV2SourceCard[] = ei.sources.map((s) => {
    const generic = isGenericReferenceSource(s.sourceType);
    return {
      id: s.id,
      label: s.label,
      sourceType: s.sourceType,
      badge: SOURCE_TYPE_BADGE[s.sourceType],
      isGeneric: generic,
      link: generic ? null : s.link,
      doi: generic ? null : s.doi,
      year: s.year,
      contributionPercent: s.contributionPercent,
      matchedWords: s.matchedWords,
      primaryKind: s.interpretation.primaryKind,
      primaryLabel: KIND_PASSAGE_LABEL[s.interpretation.primaryKind],
      meaning: KIND_MEANING[s.interpretation.primaryKind],
      confidence: s.interpretation.confidence,
      confidenceLabel: CONFIDENCE_LABEL[s.interpretation.confidence],
      reasons: s.interpretation.reasons.slice(0, 3),
      mixedKindLabels: s.interpretation.mixedKinds.map((k) => KIND_SUMMARY_LABEL[k]),
      passageRefs: [...s.passageRefs].sort((a, b) => a - b),
      namedSources: s.sourceType === "internet" || s.sourceType === "publication"
        ? []
        : (s.namedSources ?? []),
    };
  });
  // archive aggregate card DOES carry namedSources — keep them regardless of type
  ei.sources.forEach((s, i) => {
    if (s.namedSources && s.namedSources.length > 0) sources[i].namedSources = s.namedSources;
  });

  // GOLD GAP — source accounting. The Archive's cards are either one card per
  // listed source (+ one for the display-capped rest) or, on a report without
  // per-source attribution, one aggregate card: both stand for
  // archive.verifiedSourceCount documents. The aggregate card (the only card
  // with namedSources) is named for that count here too, so a report saved
  // while it still carried its top source's title reads truthfully. Which
  // shape the stored interpretation has is read off the cards themselves (an
  // aggregate card may have been stored by an older build).
  const archive = archiveSourceAccounting(report);
  let archiveCardCount = 0;
  let archiveSourceCount = 0;
  let distinctVerifiedSourcesIsLowerBound = false;
  if (archive.mode !== "none") {
    const aggregateIndex = sources.findIndex((s) => s.namedSources.length > 0);
    if (aggregateIndex >= 0) {
      const label = archiveSourceCountLabel(archive.verifiedSourceCount, archive.verifiedSourceCountIsExact);
      sources[aggregateIndex].label = label.charAt(0).toUpperCase() + label.slice(1);
      archiveCardCount = 1;
    } else {
      archiveCardCount = archive.mode === "per-source" ? archive.listed.length + (archive.unlistedPositions.length > 0 ? 1 : 0) : 1;
    }
    archiveSourceCount = archive.verifiedSourceCount;
    distinctVerifiedSourcesIsLowerBound = !archive.verifiedSourceCountIsExact;
  }
  const distinctVerifiedSources = sources.length + Math.max(0, archiveSourceCount - archiveCardCount);

  const topSources: ReportV2TopSource[] = [...sources]
    .sort((a, b) => b.matchedWords - a.matchedWords || a.id.localeCompare(b.id))
    .slice(0, 4)
    .map((s) => ({
      id: s.id,
      label: s.label,
      sourceType: s.sourceType,
      badge: s.badge,
      contributionPercent: s.contributionPercent,
      matchedWords: s.matchedWords,
      interpretationLabel: KIND_SUMMARY_LABEL[s.primaryKind],
      link: s.link,
    }));

  // passages — map word indices to char offsets in report.text
  const spans = tokenSpans(report.text ?? "", reportScoringNormalizationVersion(report));
  const passages: ReportV2Passage[] = [...ei.passages]
    .sort((a, b) => a.wordStart - b.wordStart || a.id - b.id)
    .map((p: ReportEvidencePassage) => {
      const { charStart, charEnd } = passageCharRange(spans, p.wordStart, p.wordEnd);
      const highlightText =
        charStart !== null && charEnd !== null && report.text
          ? report.text.slice(charStart, charEnd)
          : p.excerpt;
      return {
        id: p.id,
        wordStart: p.wordStart,
        wordEnd: p.wordEnd,
        charStart,
        charEnd,
        highlightText,
        excerpt: p.excerpt,
        kind: p.interpretation.kind,
        label: KIND_PASSAGE_LABEL[p.interpretation.kind],
        meaning: KIND_MEANING[p.interpretation.kind],
        tone: p.interpretation.tone,
        confidence: p.interpretation.confidence,
        confidenceLabel: CONFIDENCE_LABEL[p.interpretation.confidence],
        filter: filterOfKind(p.interpretation.kind),
        sourceIds: [...p.sourceIds].sort(),
      };
    });

  const filterCounts: Record<ReportV2Filter, number> = {
    all: passages.length,
    review: passages.filter((p) => p.filter === "review").length,
    quotations: passages.filter((p) => p.filter === "quotations").length,
    other: passages.filter((p) => p.filter === "other").length,
  };

  const deferredNote = ei.deferredKindsFolded
    ? "Common definitions and standard academic phrasing are not separated out in this version and are included above under “Verified source overlap”."
    : null;

  return {
    interpretationVersion: ei.version,
    isUnified: report.unifiedSimilarity !== undefined,
    headlineLabel: "Verified Similarity",
    summary: {
      verifiedSimilarityPercent,
      matchedWordCount,
      totalWordCount,
      distinctVerifiedSources,
      distinctVerifiedSourcesIsLowerBound,
      completion: resolveCompletionView(report.reportCompletion, report.extractionDiagnostic, verifiedSimilarityPercent),
      topSources,
      breakdown,
      deferredNote,
    },
    sources,
    passages,
    uncertainPassages: resolveUncertainPassages(report, spans),
    filterCounts,
    hasPassages: passages.length > 0,
  };
}

/** "10", or "11+" when the report only proves a lower bound. */
export function verifiedSourceCountText(summary: Pick<ReportV2ViewModel["summary"], "distinctVerifiedSources" | "distinctVerifiedSourcesIsLowerBound">): string {
  return `${summary.distinctVerifiedSources}${summary.distinctVerifiedSourcesIsLowerBound ? "+" : ""}`;
}

// convenience for tests / callers wanting just the matched-words invariant
export function reportV2MatchedWordCount(report: SimilarityReport): number {
  return report.evidenceInterpretation?.matchedWordCount ?? primaryMatchedWordCount(report);
}

// ── screen workspace selection (pure — no React) ─────────────────────────
// Kept here, not inline in components/report/report-v2/report-v2-view.tsx,
// so the manuscript-click / Previous-Next bounds logic the interactive
// workspace depends on can be tested directly, the same way every other
// derived value in this file already is — no component-render harness
// needed for it.
export type ReportV2WorkspaceSelection = { sourceId: string; passageIndex: number } | null;

/**
 * Resolves the {sourceId, passageIndex} a manuscript-passage click produces:
 * the passage's own first source, positioned at that passage's sorted index
 * within THAT source's own passageRefs (never a fresh, unrelated ordering) —
 * so re-clicking the same highlighted passage always lands on the same
 * match number. Returns null for a passage with no source (never happens
 * for a real ReportV2Passage — sourceIds is always non-empty by
 * construction — but kept total rather than throwing for a malformed/stale
 * id) or a source id the view model no longer has.
 */
export function resolveWorkspacePassageSelection(vm: ReportV2ViewModel, passageId: number): ReportV2WorkspaceSelection {
  const passage = vm.passages.find((p) => p.id === passageId);
  const sourceId = passage?.sourceIds[0];
  if (!sourceId) return null;
  const source = vm.sources.find((s) => s.id === sourceId);
  if (!source) return null;
  const sorted = [...source.passageRefs].sort((a, b) => a - b);
  const index = sorted.indexOf(passageId);
  return { sourceId, passageIndex: index < 0 ? 0 : index };
}

/**
 * Bounds-checked Previous (delta -1) / Next (delta +1) step. Returns the
 * SAME selection value, unchanged, whenever delta would move outside
 * [0, refCount - 1] — so a caller can wire this straight into a button's
 * onClick without a separate "are we at the edge" check, and a
 * disabled={...} attribute can use the identical boundary condition.
 */
export function stepWorkspaceSelection(
  selection: ReportV2WorkspaceSelection,
  refCount: number,
  delta: number,
): ReportV2WorkspaceSelection {
  if (!selection) return selection;
  const next = selection.passageIndex + delta;
  if (next < 0 || next >= refCount) return selection;
  return { ...selection, passageIndex: next };
}

// ── manuscript pagination (pure — no React) ──────────────────────────────
// Shared by the screen workspace (WorkspaceManuscript) and the paginated
// print manuscript (ReportV2PrintManuscriptPages) so both render the exact
// same page boundaries for the exact same report — never a screen page 3
// that doesn't match what the PDF calls page 3.
//
// Tuned empirically against the real print typography via a real rendered
// PDF page — not the unrelated "~450 words per original document page"
// estimate used elsewhere (e.g. the receipt's pageCount fallback), which
// describes a different document's own typography, not this rendering's.
//
// Print-density fix (retune): .submission-copy grew from 11px/1.85
// line-height to 14px/1.45 (the 11px print size measured too small —
// roughly 8.25pt physically) — line-pitch is almost unchanged (11*1.85 ≈
// 14*1.45), so page height wasn't the problem, but each 14px line now holds
// noticeably fewer words than an 11px line did, so the OLD 700-word target
// (last tuned against the smaller font) overflowed a real physical sheet by
// 4-6% on every full page once measured again at the new size. 560 was
// re-tuned the same way — against a real rendered print page, at the
// current typography — to land in the ~85-95% fill range instead.
export const MANUSCRIPT_WORDS_PER_PAGE = 560;

export type ManuscriptPageRange = { start: number; end: number };

/**
 * Splits [0, text.length) into MANUSCRIPT_WORDS_PER_PAGE-sized chunks, cut
 * only at real word boundaries (via the same tokenSpans() the rest of this
 * file already uses), and pushed forward past any occupiedRange whose own
 * [start, end) would otherwise straddle the cut — so a single highlighted
 * match is never split across two pages. occupiedRanges must be sorted
 * ascending by start and mutually non-overlapping (true by construction for
 * both callers: vm.passages' own resolved char ranges, and
 * findHighlightRanges' own returned ranges).
 *
 * REQUIRED INVARIANT (byte/code-unit exact — verified directly in
 * tests/report-v2-workspace.test.mjs): for every valid input,
 * `result.map(p => text.slice(p.start, p.end)).join("")` reconstructs
 * `text` exactly. No trimming, no normalization, no dropped or duplicated
 * characters.
 *
 * Fixed defect (found in review): the loop used to be driven by
 * `wordIndex < wordSpans.length` — but wordIndex tracks WORDS consumed, not
 * TEXT covered. Whenever an occupied range's own end was pushed to or past
 * the start of the very last word, the word-advancement step consumed
 * every remaining word in one jump, wordIndex reached wordSpans.length, and
 * the loop exited immediately — before text.length was ever emitted as a
 * final boundary. Any trailing non-word content after the last word
 * (closing punctuation, whitespace, a newline) was then silently absent
 * from every page's range, and thus from the rendered manuscript. Fixed by
 * two independent, complementary changes: (1) the loop's own termination
 * condition is now driven by TEXT coverage (`boundaries[last] < text.length`),
 * not word count, so it can never exit early regardless of how wordIndex
 * moves; (2) once a cut would reach into (or past) the last word's own
 * start — whether the plain word-count target landed there or an occupied-
 * range push extended it there — there is no further word boundary left to
 * anchor another cut against, so the whole remaining tail (through
 * text.length) is folded into that same page in one step, rather than
 * leaving a separate near-empty trailing page for just the closing
 * punctuation/whitespace. Both changes together guarantee the invariant
 * above while still never splitting a highlighted match (extending a page
 * beyond wordsPerPage whenever correctness requires it) and never
 * looping/failing to progress.
 *
 * `scoringNormalizationVersion` is the report's own contract
 * (reportScoringNormalizationVersion): the words counted per page are the
 * same words its highlights are placed by, so a report paginates exactly as
 * it did when its positions were computed. Omitted => the contract in force
 * (tokenSpans' own default).
 */
export function paginateManuscriptText(
  text: string,
  occupiedRanges: ManuscriptPageRange[],
  wordsPerPage: number = MANUSCRIPT_WORDS_PER_PAGE,
  scoringNormalizationVersion?: ScoringNormalizationVersion,
): ManuscriptPageRange[] {
  if (text.length === 0) return [];
  const wordSpans = tokenSpans(text, scoringNormalizationVersion);
  if (wordSpans.length === 0) return [{ start: 0, end: text.length }];
  const lastWordStart = wordSpans[wordSpans.length - 1].start;

  const boundaries: number[] = [0];
  let wordIndex = 0;
  while (boundaries[boundaries.length - 1] < text.length) {
    const targetWordIndex = wordIndex + wordsPerPage;
    let cut = targetWordIndex >= wordSpans.length ? text.length : wordSpans[targetWordIndex].start;
    for (const range of occupiedRanges) {
      if (cut > range.start && cut < range.end) cut = range.end;
    }
    // No word boundary remains beyond the last word's own start, so once a
    // cut reaches that far there is nothing left to anchor a further page
    // on — absorb the rest of the text (any trailing punctuation/
    // whitespace after the last word) into this same, final page.
    if (cut > lastWordStart) cut = text.length;
    cut = Math.min(cut, text.length);
    const previous = boundaries[boundaries.length - 1];
    if (cut <= previous) cut = text.length; // safety: always make forward progress
    boundaries.push(cut);
    while (wordIndex < wordSpans.length && wordSpans[wordIndex].start < cut) wordIndex += 1;
  }

  const ranges: ManuscriptPageRange[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    ranges.push({ start: boundaries[i], end: boundaries[i + 1] });
  }
  return ranges;
}
