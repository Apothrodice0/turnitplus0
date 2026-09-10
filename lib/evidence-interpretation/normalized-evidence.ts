import type { SameWorkRelationship } from "./kinds";
import type { VerifiedSpan } from "./interpret";

/**
 * PHASE 1 — one internal normalized shape for VERIFIED evidence, sufficient for
 * interpretation, produced by an adapter per evidence producer:
 *
 *   A. archive / corpus source matches      (archiveMatchedPositions + report.sources)
 *   B. scholarly verified evidence          (externalAcademicEvidence)
 *   C. prior-submission / historical evidence (historicalSubmissionMatch + previousUploadPositions)
 *   D. Selective Corpus verified evidence    (its admission results)
 *
 * Metadata and snippets in here are NEVER authoritative — they describe, they
 * do not score. The authoritative matched-position union is passed alongside
 * (`authoritativeMatchedPositions`) purely so the interpretation output can be
 * reconciled against it; it is never recomputed here.
 */

export type NormalizedSourceType =
  | "internet"
  | "publication"
  | "reference-collection"
  | "prior-submission"
  | "selective-corpus";

export type NormalizedEvidenceProducer = "archive" | "scholarly" | "prior-submission" | "selective-corpus";

/** Public-safe descriptive metadata for one matched source. Every field is
 *  optional and NON-authoritative. No internal id, hash, path, or provenance. */
export type NormalizedSourceLabelParts = {
  title: string | null;
  publication: string | null;
  /** the host portion of a public URL only (e.g. "en.wikipedia.org"). */
  hostname: string | null;
  year: number | null;
  /** a bare DOI (shown as plain text, never a claimed live link). */
  doi: string | null;
  /** a full public URL, when the producer supplied a real one. */
  url: string | null;
};

export type NormalizedVerifiedSource = {
  /** producer-scoped stable key. The report-local opaque `src-N` id is assigned
   *  later by the report builder — this key is never surfaced. */
  key: string;
  producer: NormalizedEvidenceProducer;
  sourceType: NormalizedSourceType;
  labelParts: NormalizedSourceLabelParts;
  /** verified submission spans — word indices into the submission's canonical
   *  token stream. Contiguous runs, sorted by start. */
  spans: VerifiedSpan[];
  /** |union of span positions| — for display; not authoritative. */
  matchedWordCount: number;
  /** matchedWordCount / submissionWordCount (0..1). */
  submissionCoverageFraction: number;
  /** OPTIONAL FAMILY_GUARD signal — only the selective-corpus adapter sets it. */
  familyGuardActivated?: boolean;
  dominantSpanBoilerplate?: boolean;
  /** OPTIONAL trusted same-work relationship — only the prior-submission adapter
   *  maps it, and only when an existing strong relationship signal exists
   *  (never from overlap %, Device Passport alone, same account/device alone). */
  sameWorkRelationship?: SameWorkRelationship | null;
};

export type NormalizedVerifiedEvidence = {
  submissionText: string;
  submissionWordCount: number;
  /** The authoritative deduped matched-position union that produced the headline
   *  similarity — reused verbatim, NEVER recomputed. `positionsByKind` in the
   *  report interpretation is a disjoint partition of exactly this set. */
  authoritativeMatchedPositions: number[];
  sources: NormalizedVerifiedSource[];
};

/** Union of a source's span positions. */
export function sourcePositions(source: Pick<NormalizedVerifiedSource, "spans">): Set<number> {
  const s = new Set<number>();
  for (const sp of source.spans) for (let i = sp.start; i <= sp.end; i += 1) s.add(i);
  return s;
}

/** Merge a set of word positions into contiguous [start,end] spans (inclusive). */
export function positionsToSpans(positions: Iterable<number>): VerifiedSpan[] {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const spans: VerifiedSpan[] = [];
  for (const p of sorted) {
    const last = spans[spans.length - 1];
    if (last && p <= last.end + 1) {
      last.end = p;
      last.words = last.end - last.start + 1;
    } else {
      spans.push({ start: p, end: p, words: 1 });
    }
  }
  return spans;
}

/** Public-safe hostname from a URL string, or null. Never throws. */
export function safeHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return h || null;
  } catch {
    return null;
  }
}
