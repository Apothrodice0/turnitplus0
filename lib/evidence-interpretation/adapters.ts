import type { SimilarityReport, ReportHistoricalSubmissionMatch } from "@/lib/report-types";
import type { ExternalAcademicEvidence } from "@/lib/academic-search/types";
import { mapHistoricalMatchToSameWorkRelationship } from "./same-work";
import {
  type NormalizedVerifiedSource,
  positionsToSpans,
  sourcePositions,
  safeHostname,
} from "./normalized-evidence";
import type { InterpretationSourceInput } from "./interpret";
import { archiveSourceAccounting, archiveSourceCountLabel } from "./archive-source-accounting";

/**
 * PHASE 1 — adapters that normalise each existing verified-evidence producer
 * into NormalizedVerifiedSource. Nothing here re-runs a matcher or changes a
 * position; every span is read straight from a field the frozen pipeline
 * already persisted.
 */

function coverage(matched: number, total: number): number {
  return total > 0 ? matched / total : 0;
}

// ── A. archive / corpus source matches ────────────────────────────────────
// PER-SOURCE ATTRIBUTION — one source per verified Archive document. The
// Archive scorer attributes every scored position to exactly one source; a
// report made since then lists those positions on each of its `report.sources`
// (archiveSourceAccounting checks them against the union). Each listed source
// becomes its own card with only its own words, and the words of sources the
// display cap left unlisted become one card that says so — together exactly
// the union, nothing counted twice. A report without that attribution keeps
// ONE aggregate card for the union, named for how many verified sources it
// holds (it used to carry the top source's title, which credited every
// Archive word to that one document).
export const ARCHIVE_AGGREGATE_KEY = "archive:aggregate";
export const ARCHIVE_UNLISTED_KEY = "archive:unlisted";
const ARCHIVE_DISJOINT_GROUP = "archive";

function archiveLabelParts(title: string | null): NormalizedVerifiedSource["labelParts"] {
  return { title, publication: null, hostname: null, year: null, doi: null, url: null };
}

export function normalizeArchiveEvidence(report: SimilarityReport): NormalizedVerifiedSource[] {
  const positions = report.archiveMatchedPositions ?? [];
  if (positions.length === 0) return [];
  const accounting = archiveSourceAccounting(report);

  if (accounting.mode === "per-source") {
    const sources: NormalizedVerifiedSource[] = accounting.listed.map((source, index) => ({
      key: `archive:${index}`,
      producer: "archive",
      sourceType: source.type === "Publication" ? "publication" : "internet",
      labelParts: archiveLabelParts(source.name?.trim() || null),
      spans: positionsToSpans(source.positions),
      matchedWordCount: source.positions.length,
      submissionCoverageFraction: coverage(source.positions.length, report.wordCount),
      disjointAttributionGroup: ARCHIVE_DISJOINT_GROUP,
    }));
    if (accounting.unlistedPositions.length > 0) {
      const unlisted = accounting.verifiedSourceCount - accounting.listed.length;
      sources.push({
        key: ARCHIVE_UNLISTED_KEY,
        producer: "archive",
        sourceType: "publication",
        labelParts: archiveLabelParts(
          accounting.verifiedSourceCountIsExact
            ? `${unlisted} more verified Archive source${unlisted === 1 ? "" : "s"} (not listed individually)`
            : "More verified Archive sources (not listed individually)",
        ),
        spans: positionsToSpans(accounting.unlistedPositions),
        matchedWordCount: accounting.unlistedPositions.length,
        submissionCoverageFraction: coverage(accounting.unlistedPositions.length, report.wordCount),
        disjointAttributionGroup: ARCHIVE_DISJOINT_GROUP,
      });
    }
    return sources;
  }

  const topSource = [...(report.sources ?? [])].sort((a, b) => b.percent - a.percent)[0] ?? null;
  const count = accounting.mode === "aggregate" ? accounting : { verifiedSourceCount: 1, verifiedSourceCountIsExact: false };
  return [
    {
      key: ARCHIVE_AGGREGATE_KEY,
      producer: "archive",
      sourceType: topSource?.type === "Publication" ? "publication" : "internet",
      labelParts: archiveLabelParts(archiveSourceCountLabel(count.verifiedSourceCount, count.verifiedSourceCountIsExact)),
      spans: positionsToSpans(positions),
      matchedWordCount: positions.length,
      submissionCoverageFraction: coverage(positions.length, report.wordCount),
    },
  ];
}

// ── B. scholarly verified evidence ───────────────────────────────────────
export function normalizeScholarlyEvidence(report: SimilarityReport): NormalizedVerifiedSource[] {
  const evidence: ExternalAcademicEvidence[] = report.externalAcademicEvidence ?? [];
  return evidence.map((ev, i) => {
    const spans = (ev.matchedPassages ?? [])
      .map((p) => ({
        start: p.submittedWordStart | 0,
        end: p.submittedWordEnd | 0,
        words: p.matchedWordCount | 0,
      }))
      .filter((s) => s.end >= s.start)
      .sort((a, b) => a.start - b.start);
    const matchedWordCount = sourcePositions({ spans }).size;
    const isPublication = Boolean(ev.doi || ev.publication);
    return {
      key: `scholarly:${ev.providerId || ev.provider || "x"}:${i}`,
      producer: "scholarly" as const,
      sourceType: isPublication ? ("publication" as const) : ("internet" as const),
      labelParts: {
        title: ev.title,
        publication: ev.publication,
        hostname: safeHostname(ev.url),
        year: ev.year,
        doi: ev.doi,
        url: ev.url,
      },
      spans,
      matchedWordCount,
      submissionCoverageFraction: coverage(matchedWordCount, report.wordCount),
    };
  });
}

// ── C. prior-submission / historical evidence ────────────────────────────
// Spans come from unifiedSimilarity.previousUploadPositions — the deduped,
// privacy-safe position subset (no representation id, no relationship type, no
// account identity). The trusted work/version relationship (if any) is mapped
// from historicalSubmissionMatch, which is admin-gated on the ordinary GET —
// so `historicalSubmissionMatch` is passed explicitly by a caller that has it
// (the server-side builder, before stripping).
export function normalizePriorSubmissionEvidence(
  report: SimilarityReport,
  historicalSubmissionMatch?: ReportHistoricalSubmissionMatch | null,
): NormalizedVerifiedSource[] {
  const positions = report.unifiedSimilarity?.previousUploadPositions ?? [];
  if (positions.length === 0) return [];
  const hist = historicalSubmissionMatch ?? report.historicalSubmissionMatch ?? null;
  return [
    {
      key: "prior-submission:aggregate",
      producer: "prior-submission",
      sourceType: "reference-collection",
      labelParts: { title: null, publication: null, hostname: null, year: null, doi: null, url: null },
      spans: positionsToSpans(positions),
      matchedWordCount: positions.length,
      submissionCoverageFraction: coverage(positions.length, report.wordCount),
      sameWorkRelationship: mapHistoricalMatchToSameWorkRelationship(hist),
    },
  ];
}

// ── E. user-supplied reference files ─────────────────────────────────────
// The report's own author supplied these reference files for this check. Spans
// are the SERVER-VERIFIED submission passages from lib/user-supplied-references.ts
// (computeDocumentCorrespondence + the frozen STRICT_SPAN gate) — never a
// client-authored value. sameWorkRelationship is ALWAYS null: POSSIBLE_SAME_WORK
// stays relationship-gated only and must never activate just because a reference
// was supplied, or the overlap is 80/90/100%, or the filename is similar.
// familyGuard does not apply (no indexed family for a private one-off file).
export function normalizeUserSuppliedReferenceEvidence(
  admittedReferences: ReadonlyArray<{
    key: string;
    safeLabel: string;
    verifiedPassages: ReadonlyArray<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>;
  }>,
  submissionWordCount: number,
): NormalizedVerifiedSource[] {
  return admittedReferences
    .map((ref) => {
      const spans = [...ref.verifiedPassages]
        .map((p) => ({ start: p.submittedWordStart | 0, end: p.submittedWordEnd | 0, words: p.matchedWordCount | 0 }))
        .filter((s) => s.end >= s.start)
        .sort((a, b) => a.start - b.start);
      const matchedWordCount = sourcePositions({ spans }).size;
      return {
        key: ref.key,
        producer: "user-supplied-reference" as const,
        sourceType: "user-supplied-reference" as const,
        labelParts: { title: ref.safeLabel, publication: null, hostname: null, year: null, doi: null, url: null },
        spans,
        matchedWordCount,
        submissionCoverageFraction: coverage(matchedWordCount, submissionWordCount),
        sameWorkRelationship: null,
      };
    })
    .filter((s) => s.spans.length > 0);
}

// ── F. Imported Similarity Evidence V1 (verified third-party-report passages) ──
// Every passage here is already SERVER-VERIFIED by
// lib/imported-similarity-evidence/matcher.ts (exact normalized-anchor match +
// score-mask projection) — never a client-authored value, never re-verified
// here. sameWorkRelationship is ALWAYS null (same reasoning as user-supplied
// references: an imported match must never activate POSSIBLE_SAME_WORK just
// because it exists). importedSourceAttributionState is carried through for
// internal audit only — never fed into labelParts, so a not-independently-owned
// source can never surface as if it were independently verified.
export function normalizeImportedSimilarityEvidence(
  admittedSources: ReadonlyArray<{
    key: string;
    spans: ReadonlyArray<{ start: number; end: number; words: number }>;
    sourceAttributionState?: NormalizedVerifiedSource["importedSourceAttributionState"];
  }>,
  submissionWordCount: number,
): NormalizedVerifiedSource[] {
  return admittedSources
    .map((source) => {
      const spans = [...source.spans].map((sp) => ({ start: sp.start, end: sp.end, words: sp.words })).sort((a, b) => a.start - b.start);
      const matchedWordCount = sourcePositions({ spans }).size;
      return {
        key: source.key,
        producer: "imported-similarity-evidence" as const,
        sourceType: "imported-similarity-evidence" as const,
        labelParts: { title: null, publication: null, hostname: null, year: null, doi: null, url: null },
        spans,
        matchedWordCount,
        submissionCoverageFraction: coverage(matchedWordCount, submissionWordCount),
        sameWorkRelationship: null,
        importedSourceAttributionState: source.sourceAttributionState,
      };
    })
    .filter((s) => s.spans.length > 0);
}

// ── D. Selective Corpus verified evidence ────────────────────────────────
// Not on SimilarityReport today (it is a shadow slice). A caller that has the
// selective-corpus admission results passes them here in the same shape the
// interpreter's own input uses.
export function normalizeSelectiveCorpusEvidence(
  admittedSources: ReadonlyArray<
    Pick<InterpretationSourceInput, "spans" | "familyGuardActivated" | "dominantSpanBoilerplate"> & { key?: string }
  >,
  submissionWordCount: number,
): NormalizedVerifiedSource[] {
  return admittedSources.map((s, i) => {
    const spans = [...s.spans].map((sp) => ({ start: sp.start, end: sp.end, words: sp.words })).sort((a, b) => a.start - b.start);
    const matchedWordCount = sourcePositions({ spans }).size;
    return {
      key: s.key ?? `selective-corpus:${i}`,
      producer: "selective-corpus" as const,
      sourceType: "selective-corpus" as const,
      labelParts: { title: null, publication: null, hostname: null, year: null, doi: null, url: null },
      spans,
      matchedWordCount,
      submissionCoverageFraction: coverage(matchedWordCount, submissionWordCount),
      familyGuardActivated: s.familyGuardActivated,
      dominantSpanBoilerplate: s.dominantSpanBoilerplate,
    };
  });
}
