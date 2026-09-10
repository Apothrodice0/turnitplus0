import {
  EVIDENCE_INTERPRETATION_VERSION,
  type EvidenceInterpretationKind,
  type EvidenceInterpretationConfidence,
  type SameWorkRelationship,
} from "./kinds";

/**
 * Evidence Interpretation Layer — the PURE classifier (V1, high-confidence).
 *
 * PURE EXPLANATION. Classifies already-VERIFIED submission spans — from ANY
 * evidence producer (archive, scholarly, prior-submission, selective-corpus) —
 * into the six approved user-facing kinds. It:
 *
 *   - re-runs NOTHING (no matcher, no STRICT_SPAN, no FAMILY_GUARD, no
 *     co-source attribution, no computeUnifiedSimilarity, no fingerprinting);
 *   - changes NO matched position and NO similarity number — the caller must
 *     have computed the authoritative result BEFORE calling this and must leave
 *     it untouched afterwards;
 *   - emits only bounded, non-sensitive `reasons` phrases — never a fingerprint,
 *     hash, path, internal source id, corpus digest, or provenance internal.
 *
 * POSSIBLE_SAME_WORK is emitted ONLY on a caller-supplied `sameWorkRelationship`
 * — never from overlap percentage. COMMON_DEFINITION / COMMON_ACADEMIC_LANGUAGE
 * are never produced (a span that would be one falls through to
 * DISTINCTIVE_EXTERNAL_MATCH).
 *
 * This module was generalised out of lib/selective-corpus/interpretation.ts —
 * that file is now a thin compatibility shim over this one.
 */

/** A verified submission span — word indices into the submission's canonical
 *  token stream. Shape-compatible with lib/selective-corpus/verify.ts's
 *  SelectiveCorpusVerifiedSpan and lib/academic-search MatchedPassage. */
export type VerifiedSpan = { start: number; end: number; words?: number };

export type EvidenceSpanInterpretation = {
  kind: EvidenceInterpretationKind;
  confidence: EvidenceInterpretationConfidence;
  /** 0-based word indices into the SUBMISSION's own canonical token stream
   *  (safe — a position in the user's own document, not a corpus internal). */
  wordRange: [start: number, end: number];
  /** Bounded, non-sensitive explanation phrases. */
  reasons: string[];
};

/** One matched source's verified spans plus the facts the interpreter needs —
 *  ALL already produced by a frozen pipeline or a trusted subsystem. */
export type InterpretationSourceInput = {
  /** caller-chosen key, used only to key the result map (never surfaced). */
  key: string;
  spans: readonly VerifiedSpan[];
  /** FAMILY_GUARD's own verdict for this source (selective-corpus only today;
   *  false for archive / scholarly / prior-submission). */
  familyGuardActivated: boolean;
  dominantSpanBoilerplate: boolean;
  /** fraction of the submission's words this source's spans cover (0..1) — used
   *  ONLY to keep a whole-document twin from being the "canonical larger
   *  source" in LEGITIMATE_ALTERNATE_SOURCE detection; NEVER a same-work signal. */
  submissionCoverageFraction: number;
  /** An EXISTING trusted work/version relationship. When absent/null,
   *  POSSIBLE_SAME_WORK is NOT emitted for this source. */
  sameWorkRelationship?: SameWorkRelationship | null;
};

export type InterpretationInput = {
  /** the submission's own raw text (for quotation-mark / citation context). */
  submissionText: string;
  submissionWordCount: number;
  sources: readonly InterpretationSourceInput[];
};

export type InterpretationResult = {
  /** key -> per-span interpretations, same order and count as the source's spans. */
  bySource: Map<string, EvidenceSpanInterpretation[]>;
  /** aggregate SPAN counts per kind (not word counts — see build-report-interpretation.ts). */
  counts: Record<EvidenceInterpretationKind, number>;
  version: string;
};

// ---------------------------------------------------------------------------
// Offset-preserving tokenisation — same word sequence as lib/similarity-core
// tokens(), plus each word's char offset, so quotation marks / citations that
// tokens() strips are visible. Local re-derivation (same maximal-run scan
// lib/similarity-core.ts tokenSpans() documents) — no scoring-core import cycle.
// ---------------------------------------------------------------------------
type WordSpan = { start: number; end: number };

function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m = re.exec(text);
  while (m) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    m = re.exec(text);
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Typographic quotation regions. V1 trusts ONLY curly quotes (" " and ' '):
// straight ASCII quotes are overwhelmingly scare quotes / code / titles /
// dialogue and too ambiguous for a user-facing label. Curly pairs are
// depth-matched so an internal close resolves to the OUTERMOST region.
// ---------------------------------------------------------------------------
type QuoteRegion = { start: number; end: number };

function quotationRegions(text: string): QuoteRegion[] {
  const regions: QuoteRegion[] = [];
  for (const [open, close, minLen] of [["“", "”", 15], ["‘", "’", 25]] as const) {
    let depth = 0;
    let outerStart = -1;
    const re = new RegExp(`[${open}${close}]`, "g");
    let m = re.exec(text);
    while (m) {
      if (m[0] === open) {
        if (depth === 0) outerStart = m.index;
        depth += 1;
      } else if (depth > 0) {
        depth -= 1;
        if (depth === 0 && outerStart >= 0) {
          const len = m.index - outerStart;
          if (len >= minLen && len <= 12000) regions.push({ start: outerStart, end: m.index + 1 });
          outerStart = -1;
        }
      }
      m = re.exec(text);
    }
  }
  return regions.sort((a, b) => a.start - b.start);
}

const SIGNAL_PHRASE =
  /\b(as\s+(noted|stated|observed|described|argued|explained|reported|written|cited|quoted|summar[is]zed|put)\s+(in|by)|according\s+to|as\s+per\b|quoted\s+(in|by|from)|cited\s+(in|by)|in\s+the\s+words\s+of|writes?\s+that|argues?\s+that|notes?\s+that|states?\s+that|observ(es|ed)\s+that|explain(s|ed)\s+that|the\s+(report|paper|study|article|author|text)\s+(notes|states|says|argues|explains)|per\s+the)\b/i;
const NAMED_SOURCE_IN_QUOTES = /\b(?:in|from|see|of|per|to)\s+["“][^"”]{3,120}["”]/i;
const AUTHOR_YEAR =
  /\([A-Z][A-Za-z.'’-]+(?:\s+(?:et\s+al\.?|and|&|,)\s*[A-Z][A-Za-z.'’-]+){0,3},?\s*(?:19|20)\d{2}[a-z]?\)/;
const NARRATIVE_CITE = /\b[A-Z][A-Za-z.'’-]+(?:\s+(?:et\s+al\.?|and|&)\s+[A-Z][A-Za-z.'’-]+)?\s+\((?:19|20)\d{2}[a-z]?\)/;
const NUMERIC_CITE = /\[\d{1,3}(?:\s*[–,-]\s*\d{1,3})*\]/;
const FOOTNOTE_SUP = /[¹²³⁰-⁹†‡]/;

type CitationSignals = { attributionPhrase: boolean; authorYear: boolean; bracketNumber: boolean; footnote: boolean };

function citationNear(text: string, regionStart: number, regionEnd: number): CitationSignals {
  const pre = text.slice(Math.max(0, regionStart - 240), regionStart + 20);
  const post = text.slice(regionEnd - 20, Math.min(text.length, regionEnd + 240));
  const win = `${pre}  ⟦Q⟧  ${post}`;
  return {
    attributionPhrase: SIGNAL_PHRASE.test(win) || NAMED_SOURCE_IN_QUOTES.test(pre),
    authorYear: AUTHOR_YEAR.test(win) || NARRATIVE_CITE.test(win),
    bracketNumber: NUMERIC_CITE.test(win),
    footnote: FOOTNOTE_SUP.test(`${text.slice(Math.max(0, regionStart - 4), regionStart)}${text.slice(regionEnd, regionEnd + 4)}`),
  };
}

function spanQuotation(text: string, words: WordSpan[], span: VerifiedSpan, regions: QuoteRegion[]) {
  const cs = words[span.start]?.start ?? 0;
  const ce = words[Math.min(span.end, words.length - 1)]?.end ?? text.length;
  const len = Math.max(1, ce - cs);
  let best: QuoteRegion | null = null;
  let bestOverlap = 0;
  for (const r of regions) {
    const ov = Math.max(0, Math.min(ce, r.end) - Math.max(cs, r.start));
    if (ov > bestOverlap) {
      bestOverlap = ov;
      best = r;
    }
  }
  if (!best || bestOverlap / len < 0.55) return { quoted: false as const };
  return { quoted: true as const, citation: citationNear(text, best.start, best.end) };
}

function positionsOf(spans: readonly VerifiedSpan[]): Set<number> {
  const s = new Set<number>();
  for (const sp of spans) for (let i = sp.start; i <= sp.end; i += 1) s.add(i);
  return s;
}

function coveredBy(a: Set<number>, b: Set<number>, slack = 5): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const p of a) {
    let ok = false;
    for (let d = -slack; d <= slack && !ok; d += 1) if (b.has(p + d)) ok = true;
    if (ok) hit += 1;
  }
  return hit / a.size;
}

export function interpretVerifiedEvidence(input: InterpretationInput): InterpretationResult {
  const counts: Record<EvidenceInterpretationKind, number> = {
    DECLARED_QUOTATION: 0,
    ATTRIBUTED_QUOTATION: 0,
    POSSIBLE_SAME_WORK: 0,
    FAMILY_BOILERPLATE: 0,
    LEGITIMATE_ALTERNATE_SOURCE: 0,
    DISTINCTIVE_EXTERNAL_MATCH: 0,
  };
  const bySource = new Map<string, EvidenceSpanInterpretation[]>();

  const words = wordSpans(input.submissionText);
  const regions = quotationRegions(input.submissionText);

  const positionsByKey = new Map<string, Set<number>>();
  for (const src of input.sources) positionsByKey.set(src.key, positionsOf(src.spans));

  for (const src of input.sources) {
    const myPositions = positionsByKey.get(src.key)!;
    const sameWork = src.sameWorkRelationship != null;

    let redundantWithLarger = false;
    if (!sameWork) {
      for (const other of input.sources) {
        if (other.key === src.key) continue;
        if (other.submissionCoverageFraction >= 0.55) continue; // don't treat a twin as the "primary"
        const otherPositions = positionsByKey.get(other.key)!;
        if (otherPositions.size <= myPositions.size) continue;
        if (coveredBy(myPositions, otherPositions) >= 0.9) {
          redundantWithLarger = true;
          break;
        }
      }
    }

    const spanInterps: EvidenceSpanInterpretation[] = src.spans.map((span, index) => {
      const spanWords = span.words ?? span.end - span.start + 1;
      const wordRange: [number, number] = [span.start, span.end];

      const q = spanQuotation(input.submissionText, words, span, regions);
      if (q.quoted) {
        const cites: string[] = [];
        if (q.citation.attributionPhrase) cites.push("a nearby phrase attributes the quotation to a named source");
        if (q.citation.authorYear) cites.push("an author–year citation appears next to the quotation");
        if (q.citation.bracketNumber) cites.push("a bracketed reference number appears next to the quotation");
        if (q.citation.footnote) cites.push("a footnote marker appears next to the quotation");
        if (cites.length > 0) {
          counts.ATTRIBUTED_QUOTATION += 1;
          return { kind: "ATTRIBUTED_QUOTATION", confidence: "high", wordRange, reasons: ["the matched text is enclosed in quotation marks", ...cites] };
        }
        counts.DECLARED_QUOTATION += 1;
        return { kind: "DECLARED_QUOTATION", confidence: "high", wordRange, reasons: ["the matched text is enclosed in quotation marks", "no citation was found next to it"] };
      }

      if (sameWork) {
        counts.POSSIBLE_SAME_WORK += 1;
        return {
          kind: "POSSIBLE_SAME_WORK",
          confidence: "medium",
          wordRange,
          reasons: ["a recorded work/version relationship links this source to your document", "it may be the same work or an earlier version of it"],
        };
      }

      if (src.familyGuardActivated && src.dominantSpanBoilerplate && index === 0) {
        counts.FAMILY_BOILERPLATE += 1;
        return {
          kind: "FAMILY_BOILERPLATE",
          confidence: "high",
          wordRange,
          reasons: ["this wording also appears across several other reference documents", "it is standard/boilerplate phrasing rather than distinctive copying"],
        };
      }

      if (redundantWithLarger) {
        counts.LEGITIMATE_ALTERNATE_SOURCE += 1;
        return {
          kind: "LEGITIMATE_ALTERNATE_SOURCE",
          confidence: "medium",
          wordRange,
          reasons: ["another matched source already covers this same passage", "the passage has more than one valid source"],
        };
      }

      counts.DISTINCTIVE_EXTERNAL_MATCH += 1;
      return {
        kind: "DISTINCTIVE_EXTERNAL_MATCH",
        confidence: spanWords >= 40 ? "high" : "medium",
        wordRange,
        reasons: ["distinctive text that matches this source"],
      };
    });

    bySource.set(src.key, spanInterps);
  }

  return { bySource, counts, version: EVIDENCE_INTERPRETATION_VERSION };
}
