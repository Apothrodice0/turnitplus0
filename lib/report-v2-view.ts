import {
  primaryMatchedWordCount,
  primarySimilarityScore,
  type SimilarityReport,
} from "@/lib/report-types";
import type {
  ReportEvidenceInterpretation,
  ReportEvidenceNamedSource,
  ReportEvidencePassage,
  ReportEvidenceSource,
} from "@/lib/evidence-interpretation/report-payload-types";
import type { ReportCompletion } from "@/lib/evidence-interpretation/completion";
import type { ReportExtractionDiagnostic } from "@/lib/evidence-interpretation/extraction";
import { skippedUnitCount } from "@/lib/evidence-interpretation/extraction";
import type {
  EvidenceInterpretationConfidence,
  EvidenceInterpretationKind,
  EvidenceInterpretationTone,
} from "@/lib/evidence-interpretation/kinds";
import { EVIDENCE_INTERPRETATION_KINDS } from "@/lib/evidence-interpretation/kinds";
import { tokenSpans } from "@/lib/similarity-core";

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
};

/** Non-attributable buckets — no external link, no named document, ever. */
export function isGenericReferenceSource(sourceType: ReportV2SourceType): boolean {
  return (
    sourceType === "reference-collection" ||
    sourceType === "prior-submission" ||
    sourceType === "selective-corpus"
  );
}

export const COMPLETION_SCOPE_LINE =
  "Compared against TurnitPlus’s reference collection and live academic sources (OpenAIRE, Europe PMC). Exact Wikipedia phrase matches are listed separately and do not change this result.";

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
  headline: string;
  detail: string | null;
  /** true only for a genuine EXTRACTION_PARTIAL — never for completeness "UNKNOWN". */
  extractionPartial: boolean;
  scopeLine: string;
  signals: ReportCompletion["signals"];
};

export type ReportV2ViewModel = {
  interpretationVersion: string;
  isUnified: boolean;
  headlineLabel: string;
  summary: {
    verifiedSimilarityPercent: number;
    matchedWordCount: number;
    totalWordCount: number;
    distinctVerifiedSources: number;
    completion: ReportV2Completion;
    topSources: ReportV2TopSource[];
    breakdown: ReportV2BreakdownRow[];
    /** present only when the interpreter folded common-definition / common-academic spans into DISTINCTIVE. */
    deferredNote: string | null;
  };
  sources: ReportV2SourceCard[];
  passages: ReportV2Passage[];
  filterCounts: Record<ReportV2Filter, number>;
  /** true when the document had matched positions but none produced a passage row. */
  hasPassages: boolean;
};

// ── completion copy ──────────────────────────────────────────────────────
function resolveCompletionView(
  completion: ReportCompletion | undefined,
  extraction: ReportExtractionDiagnostic | undefined,
  verifiedSimilarityPercent: number,
): ReportV2Completion {
  const state = completion?.state ?? "COMPLETED";
  const extractionPartial = state === "EXTRACTION_PARTIAL" && (extraction?.completeness === "PARTIAL");

  // Prefer the server-authored headline/detail; fall back to deterministic copy
  // so a legacy/oddly-shaped completion object still renders sane, non-alarming
  // text (and never the EXTRACTION_PARTIAL wording when completeness is UNKNOWN).
  const HEADLINE: Record<ReportCompletion["state"], string> = {
    COMPLETED: "Search completed within the available TurnitPlus source scope.",
    PARTIAL: "Some source searches were unavailable. Results may be incomplete.",
    SOURCE_UNAVAILABLE: "A candidate source was identified but its text could not be verified.",
    EXTRACTION_PARTIAL: "Part of the uploaded document could not be analyzed.",
  };
  const effectiveState: ReportCompletion["state"] =
    state === "EXTRACTION_PARTIAL" && !extractionPartial ? "PARTIAL" : state;

  let detail = completion?.detail ?? null;
  if (effectiveState === "COMPLETED") detail = null;
  else if (!detail) {
    if (effectiveState === "PARTIAL") {
      detail = `The ${verifiedSimilarityPercent}% shown is a lower bound — a source we could not reach may add more.`;
    } else if (effectiveState === "SOURCE_UNAVAILABLE") {
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

  return {
    state: effectiveState,
    headline: completion?.headline?.trim() || HEADLINE[effectiveState],
    detail,
    extractionPartial,
    scopeLine: COMPLETION_SCOPE_LINE,
    signals: completion?.signals ?? {
      academicSearch: null,
      selectiveCorpus: null,
      extraction: extraction?.completeness ?? "UNKNOWN",
      unverifiedCandidateCount: 0,
    },
  };
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
  const spans = tokenSpans(report.text ?? "");
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
      distinctVerifiedSources: sources.length,
      completion: resolveCompletionView(report.reportCompletion, report.extractionDiagnostic, verifiedSimilarityPercent),
      topSources,
      breakdown,
      deferredNote,
    },
    sources,
    passages,
    filterCounts,
    hasPassages: passages.length > 0,
  };
}

// convenience for tests / callers wanting just the matched-words invariant
export function reportV2MatchedWordCount(report: SimilarityReport): number {
  return report.evidenceInterpretation?.matchedWordCount ?? primaryMatchedWordCount(report);
}
