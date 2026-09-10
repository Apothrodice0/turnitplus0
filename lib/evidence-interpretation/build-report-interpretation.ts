import type { SimilarityReport, ReportHistoricalSubmissionMatch } from "@/lib/report-types";
import { tokens } from "@/lib/similarity-core";
import {
  EVIDENCE_INTERPRETATION_VERSION,
  TONE_BY_KIND,
  moreSpecificKind,
  type EvidenceInterpretationKind,
  type EvidenceInterpretationConfidence,
} from "./kinds";
import { interpretVerifiedEvidence, type EvidenceSpanInterpretation, type InterpretationSourceInput } from "./interpret";
import {
  type NormalizedSourceType,
  type NormalizedVerifiedEvidence,
  type NormalizedVerifiedSource,
  safeHostname,
} from "./normalized-evidence";
import {
  normalizeArchiveEvidence,
  normalizeScholarlyEvidence,
  normalizePriorSubmissionEvidence,
  normalizeSelectiveCorpusEvidence,
  normalizeUserSuppliedReferenceEvidence,
} from "./adapters";
import type {
  ReportEvidenceInterpretation,
  ReportEvidenceSource,
  ReportEvidenceNamedSource,
  ReportEvidencePassage,
} from "./report-payload-types";

export type {
  ReportEvidenceInterpretation,
  ReportEvidenceSource,
  ReportEvidenceNamedSource,
  ReportEvidencePassage,
} from "./report-payload-types";

/**
 * PHASE 3 + PHASE 4 — the additive, explanation-only report interpretation
 * payload. Built from evidence the frozen pipeline already persisted; re-runs
 * nothing; changes no matched position and no similarity number.
 *
 * `positionsByKind` is a DISJOINT partition of the authoritative matched-
 * position union, so `countsByKind` totals reconcile EXACTLY with the headline
 * similarity's matched-word count.
 *
 * Every source carries a report-local opaque id (`src-1`..`src-n`), stable for
 * the same persisted evidence. No corpus id, DB id, hash, fingerprint, path,
 * Passport/HMAC/provenance internal, or other-account identity ever appears.
 */

const EMPTY_BY_KIND = (): Record<EvidenceInterpretationKind, number[]> => ({
  DECLARED_QUOTATION: [],
  ATTRIBUTED_QUOTATION: [],
  POSSIBLE_SAME_WORK: [],
  FAMILY_BOILERPLATE: [],
  LEGITIMATE_ALTERNATE_SOURCE: [],
  DISTINCTIVE_EXTERNAL_MATCH: [],
});

export type BuildReportEvidenceInterpretationOptions = {
  /** admin-gated on the ordinary GET — a server-side caller that still has it
   *  passes it here so POSSIBLE_SAME_WORK can be produced before stripping. */
  historicalSubmissionMatch?: ReportHistoricalSubmissionMatch | null;
  /** Selective Corpus admitted-source spans, when that channel is a real report
   *  evidence producer for this report (not on SimilarityReport today). */
  selectiveCorpusAdmittedSources?: ReadonlyArray<
    Pick<InterpretationSourceInput, "spans" | "familyGuardActivated" | "dominantSpanBoilerplate"> & { key?: string }
  >;
  /** SERVER-VERIFIED user-supplied reference evidence (lib/user-supplied-references.ts).
   *  Absent unless the report carried supplied reference files. Only ADMITTED
   *  references with real verified passages should be passed. */
  userSuppliedReferences?: ReadonlyArray<{
    key: string;
    safeLabel: string;
    verifiedPassages: ReadonlyArray<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>;
  }>;
};

// ── build the normalized evidence bundle ─────────────────────────────────
export function normalizeReportEvidence(
  report: SimilarityReport,
  opts: BuildReportEvidenceInterpretationOptions = {},
): NormalizedVerifiedEvidence {
  const authoritative = report.unifiedSimilarity?.matchedPositions ?? report.archiveMatchedPositions ?? [];
  const authoritativeMatchedPositions = [...new Set(authoritative)].sort((a, b) => a - b);
  const sources: NormalizedVerifiedSource[] = [
    ...normalizeArchiveEvidence(report),
    ...normalizeScholarlyEvidence(report),
    ...normalizePriorSubmissionEvidence(report, opts.historicalSubmissionMatch),
    ...(opts.selectiveCorpusAdmittedSources
      ? normalizeSelectiveCorpusEvidence(opts.selectiveCorpusAdmittedSources, report.wordCount)
      : []),
    ...normalizeUserSuppliedReferenceEvidence(opts.userSuppliedReferences ?? [], report.wordCount),
  ];
  return {
    submissionText: report.text ?? "",
    submissionWordCount: report.wordCount ?? 0,
    authoritativeMatchedPositions,
    sources,
  };
}

// ── deterministic report-local opaque ids ───────────────────────────────
const PRODUCER_ORDER: Record<NormalizedVerifiedSource["producer"], number> = {
  archive: 0,
  scholarly: 1,
  "prior-submission": 2,
  "selective-corpus": 3,
  "user-supplied-reference": 4,
};

function assignOpaqueIds(sources: NormalizedVerifiedSource[]): Map<string, string> {
  const ordered = [...sources].sort(
    (a, b) =>
      b.matchedWordCount - a.matchedWordCount ||
      PRODUCER_ORDER[a.producer] - PRODUCER_ORDER[b.producer] ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const map = new Map<string, string>();
  ordered.forEach((s, i) => map.set(s.key, `src-${i + 1}`));
  return map;
}

// ── public-safe label fallback chain ───────────────────────────────────
const GENERIC_LABEL: Record<NormalizedSourceType, string> = {
  internet: "Internet source",
  publication: "Publication",
  "reference-collection": "TurnitPlus reference collection",
  "prior-submission": "Earlier submission",
  "selective-corpus": "TurnitPlus reference collection",
  "user-supplied-reference": "Supplied reference",
};

function safeLabel(source: NormalizedVerifiedSource): string {
  const p = source.labelParts;
  return (
    p.title?.trim() ||
    p.publication?.trim() ||
    p.hostname?.trim() ||
    safeHostname(p.url) ||
    GENERIC_LABEL[source.sourceType]
  );
}

const CONFIDENCE_RANK: Record<EvidenceInterpretationConfidence, number> = { low: 0, medium: 1, high: 2 };

// ── main builder ───────────────────────────────────────────────────────
export function buildReportEvidenceInterpretation(
  report: SimilarityReport,
  opts: BuildReportEvidenceInterpretationOptions = {},
): ReportEvidenceInterpretation {
  const evidence = normalizeReportEvidence(report, opts);
  const authoritativeSet = new Set(evidence.authoritativeMatchedPositions);

  const interp = interpretVerifiedEvidence({
    submissionText: evidence.submissionText,
    submissionWordCount: evidence.submissionWordCount,
    sources: evidence.sources.map((s) => ({
      key: s.key,
      spans: s.spans,
      familyGuardActivated: s.familyGuardActivated ?? false,
      dominantSpanBoilerplate: s.dominantSpanBoilerplate ?? false,
      submissionCoverageFraction: s.submissionCoverageFraction,
      sameWorkRelationship: s.sameWorkRelationship ?? null,
    })),
  });

  // position -> most-specific kind, restricted to the authoritative union
  const kindAt = new Map<number, EvidenceInterpretationKind>();
  const sourcesAtPos = new Map<number, Set<string>>();
  for (const src of evidence.sources) {
    const spanInterps = interp.bySource.get(src.key) ?? [];
    src.spans.forEach((span, i) => {
      const si: EvidenceSpanInterpretation | undefined = spanInterps[i];
      if (!si) return;
      for (let p = span.start; p <= span.end; p += 1) {
        if (!authoritativeSet.has(p)) continue;
        const prev = kindAt.get(p);
        kindAt.set(p, prev ? moreSpecificKind(prev, si.kind) : si.kind);
        if (!sourcesAtPos.has(p)) sourcesAtPos.set(p, new Set());
        sourcesAtPos.get(p)!.add(src.key);
      }
    });
  }

  // disjoint positionsByKind — every authoritative position lands in exactly one
  const positionsByKind = EMPTY_BY_KIND();
  for (const p of evidence.authoritativeMatchedPositions) {
    positionsByKind[kindAt.get(p) ?? "DISTINCTIVE_EXTERNAL_MATCH"].push(p);
  }
  const countsByKind = Object.fromEntries(
    (Object.keys(positionsByKind) as EvidenceInterpretationKind[]).map((k) => [k, positionsByKind[k].length]),
  ) as Record<EvidenceInterpretationKind, number>;
  const matchedWordCount = evidence.authoritativeMatchedPositions.length;

  // ── passages: contiguous runs of same kind + same source-set ──────────
  const tokenList = tokens(evidence.submissionText);
  const passages: ReportEvidencePassage[] = [];
  const idMap = assignOpaqueIds(evidence.sources);
  const keyToId = (key: string) => idMap.get(key) ?? "src-?";
  let cur: { start: number; end: number; kind: EvidenceInterpretationKind; keys: string; keyList: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const excerptTokens = tokenList.slice(cur.start, Math.min(cur.end + 1, cur.start + 40));
    passages.push({
      id: passages.length,
      wordStart: cur.start,
      wordEnd: cur.end,
      excerpt: `${excerptTokens.join(" ")}${cur.end - cur.start + 1 > excerptTokens.length ? " …" : ""}`,
      sourceIds: [...new Set(cur.keyList.map(keyToId))].sort(),
      interpretation: {
        kind: cur.kind,
        confidence: cur.kind === "DISTINCTIVE_EXTERNAL_MATCH" && cur.end - cur.start + 1 < 40 ? "medium" : "high",
        tone: TONE_BY_KIND[cur.kind],
      },
    });
    cur = null;
  };
  for (const p of evidence.authoritativeMatchedPositions) {
    const kind = kindAt.get(p) ?? "DISTINCTIVE_EXTERNAL_MATCH";
    const keyList = [...(sourcesAtPos.get(p) ?? new Set<string>())].sort();
    const keys = keyList.join("|");
    if (cur && p === cur.end + 1 && cur.kind === kind && cur.keys === keys) {
      cur.end = p;
    } else {
      flush();
      cur = { start: p, end: p, kind, keys, keyList };
    }
  }
  flush();

  // ── source cards ─────────────────────────────────────────────────────
  const sources: ReportEvidenceSource[] = evidence.sources.map((src) => {
    const id = keyToId(src.key);
    const spanInterps = interp.bySource.get(src.key) ?? [];
    // kind distribution over this source's own authoritative positions
    const wordsByKind = EMPTY_BY_KIND();
    src.spans.forEach((span, i) => {
      const k = spanInterps[i]?.kind;
      if (!k) return;
      for (let p = span.start; p <= span.end; p += 1) if (authoritativeSet.has(p)) wordsByKind[k].push(p);
    });
    const present = (Object.keys(wordsByKind) as EvidenceInterpretationKind[]).filter((k) => wordsByKind[k].length > 0);
    present.sort((a, b) => wordsByKind[b].length - wordsByKind[a].length);
    const primaryKind = present[0] ?? "DISTINCTIVE_EXTERNAL_MATCH";
    // pick a representative reasons list for the primary kind
    const baseReasons =
      spanInterps.find((s) => s.kind === primaryKind)?.reasons ?? ["distinctive text that matches this source"];
    // USER-SUPPLIED REFERENCES V1.1 (RULE 1) — make the trust semantics explicit
    // on the card: this text also appears in a file the report's OWN author
    // supplied. The overlap is matcher-verified; the source is NOT represented
    // as independently discovered or independently authenticated. (This is
    // presentation copy — the kind classification itself is unchanged.)
    const repReasons =
      src.producer === "user-supplied-reference"
        ? ["this text also appears in a reference file you supplied", ...baseReasons.filter((r) => r !== "distinctive text that matches this source")]
        : baseReasons;
    const repConfidence = spanInterps
      .filter((s) => s.kind === primaryKind)
      .reduce<EvidenceInterpretationConfidence>(
        (acc, s) => (CONFIDENCE_RANK[s.confidence] > CONFIDENCE_RANK[acc] ? s.confidence : acc),
        "low",
      );
    const passageRefs = passages.filter((pg) => pg.sourceIds.includes(id)).map((pg) => pg.id);

    const namedSources: ReportEvidenceNamedSource[] | undefined =
      src.producer === "archive"
        ? (report.sources ?? []).map((s) => ({
            label: s.name?.trim() || GENERIC_LABEL.internet,
            contributionPercent: Math.round(s.percent),
            matchedWords: s.matchedWords ?? Math.round((s.percent / 100) * (report.wordCount || 1)),
          }))
        : undefined;

    return {
      id,
      label: safeLabel(src),
      sourceType: src.sourceType,
      link: src.labelParts.url ?? null,
      doi: src.labelParts.doi ?? null,
      year: src.labelParts.year ?? null,
      contributionPercent: Math.min(
        100,
        Math.round((src.matchedWordCount / Math.max(1, report.wordCount || 1)) * 100),
      ),
      matchedWords: src.matchedWordCount,
      interpretation: {
        primaryKind,
        confidence: primaryKind === "DISTINCTIVE_EXTERNAL_MATCH" && src.producer === "archive" ? "low" : repConfidence === "low" ? "medium" : repConfidence,
        reasons: repReasons.slice(0, 3),
        mixedKinds: present.slice(1),
      },
      passageRefs,
      ...(namedSources && namedSources.length > 0 ? { namedSources } : {}),
    };
  });
  sources.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    version: EVIDENCE_INTERPRETATION_VERSION,
    positionsByKind,
    countsByKind,
    matchedWordCount,
    sources,
    passages,
    deferredKindsFolded: false,
  };
}
