import { SELECTIVE_CORPUS_FAMILY_GUARD, SELECTIVE_CORPUS_STOP_DF, SELECTIVE_CORPUS_STRICT_SPAN } from "../selective-corpus/constants";
import { winnowWordSpanHashes } from "../selective-corpus/fingerprint";
import type { SelectiveCorpusAdmissionResult, SelectiveCorpusVerifiedSpan } from "../selective-corpus/verify";

/**
 * Corpus Engine v1 — the family admission policy, versioned on its own.
 *
 * WHAT THIS REPLACES, AND WHY
 *
 * The release candidate's FAMILY_GUARD (lib/selective-corpus/verify.ts) was
 * frozen with the rule "the family guard changes source attribution only —
 * matched text is never globally suppressed". Its implementation keeps that
 * rule only while some holder of a shared passage is admitted for another
 * reason. It decides "shared" with an ABSOLUTE count (a fingerprint held by
 * >= 13 documents, a passage held by >= 3), so as a corpus grows every holder
 * of a passage is suppressed and the passage's verified positions leave the
 * report. Measured at 100k documents: 27 of 191 copied-from sources
 * suppressed, 4,492 matched positions covered by no admitted source.
 *
 * corpus-family-admission-v2 keeps the guard's purpose and removes that
 * failure:
 *
 *   1. Every verified span is classified from ONE generation-wide statistic,
 *      its HOLDERS: the documents of the pinned generation that hold at least
 *      spanContainmentFraction of the span's winnowed fingerprints (every
 *      fingerprint counts, whatever its document frequency).
 *
 *        holders <  familyDocuments           specific  the span belongs to this source
 *        holders >= familyDocuments           family    the same passage is held by a family of sources
 *        holders >= genericFamilyDocuments(N) generic   the passage is common text of the corpus
 *
 *   2. A candidate whose dominant span is specific, or that carries
 *      independentWords of specific text, is a SOURCE — as before.
 *
 *   3. A candidate with no such text of its own, but with independentWords of
 *      text that is not generic, is a FAMILY MEMBER. Members are not each
 *      attributed (that is the guard's job, kept), and they are not discarded
 *      either: per query, members are taken in one canonical order and a
 *      member becomes its family's REPRESENTATIVE when it holds a verified
 *      position no admitted source already covers. Every other member is
 *      COLLAPSED into the sources that cover it. So a family of 3 and a
 *      family of 300 bring the same positions to the report, through one
 *      representative.
 *
 *   4. A candidate with nothing but generic text is suppressed, as before.
 *
 * THE GENERIC BOUND IS A RATE, NOT A COUNT. The guard was frozen with "a
 * fingerprint in >= 13 documents is boilerplate" on an index of 5,054
 * documents (strict-span-family-final, policy sha256 01deb1e0…). v2 keeps that
 * frozen proportion — 13 documents per 5,054 — and applies it to the document
 * count of the generation being searched, never below 13. A passage does not
 * become generic because the corpus doubled; it becomes generic when the same
 * share of the corpus holds it.
 *
 * WHAT THIS IS NOT. It does not match, score or unite anything. Spans come
 * from the existing matcher; credited spans go to the existing co-source
 * attribution and the existing union and score, unchanged. No learned model,
 * no clustering: a family is the set of documents the index says hold the
 * span.
 */

/** The release candidate's FAMILY_GUARD, exactly as lib/selective-corpus/verify.ts applies it. */
export const FAMILY_ADMISSION_POLICY_GUARD_V1 = "selective-family-guard-v1";
/** Family-aware admission: one representative per family, generic bound relative to the generation. */
export const FAMILY_ADMISSION_POLICY_AWARE_V2 = "corpus-family-admission-v2";
/** STRICT_SPAN alone, no family rule. FOR MEASUREMENT ONLY — it attributes a shared passage to every holder. */
export const FAMILY_ADMISSION_POLICY_STRICT_SPAN_ONLY = "strict-span-only-measurement";

export type FamilyAdmissionPolicyId =
  | typeof FAMILY_ADMISSION_POLICY_GUARD_V1
  | typeof FAMILY_ADMISSION_POLICY_AWARE_V2
  | typeof FAMILY_ADMISSION_POLICY_STRICT_SPAN_ONLY;

export const FAMILY_ADMISSION_POLICIES: readonly FamilyAdmissionPolicyId[] = [
  FAMILY_ADMISSION_POLICY_GUARD_V1,
  FAMILY_ADMISSION_POLICY_AWARE_V2,
  FAMILY_ADMISSION_POLICY_STRICT_SPAN_ONLY,
];

/** What the engine applies unless a caller names another policy. */
export const DEFAULT_FAMILY_ADMISSION_POLICY: FamilyAdmissionPolicyId = FAMILY_ADMISSION_POLICY_AWARE_V2;

/**
 * v2's constants. Each is the guard's own frozen value, re-used; the only new
 * number is the size of the index the guard's stop frequency was frozen on.
 */
export const CORPUS_FAMILY_ADMISSION_V2 = {
  /** A span held by this many documents is a family's, not one source's. */
  familyDocuments: SELECTIVE_CORPUS_FAMILY_GUARD.dominantSpanFamilyDocThreshold,
  /** A document holds a span when it holds this share of the span's fingerprints. */
  spanContainmentFraction: SELECTIVE_CORPUS_FAMILY_GUARD.spanContainmentFraction,
  /** The guard's unit of independent evidence, in verified words. */
  independentWords: SELECTIVE_CORPUS_FAMILY_GUARD.additionalSourceSpecificWords,
  /** The guard's frozen stop frequency … */
  genericStopDocuments: SELECTIVE_CORPUS_STOP_DF,
  /** … and the document count of the index it was frozen on. */
  genericCalibrationDocuments: 5054,
} as const;

/**
 * How many holders make a span generic in a generation of `documentCount`
 * documents: the frozen 13-per-5,054 share of it, rounded up, never below 13.
 * Integer arithmetic, so the bound is the same on every machine.
 */
export function genericFamilyDocuments(documentCount: number): number {
  if (!Number.isSafeInteger(documentCount) || documentCount < 0) throw new RangeError("documentCount must be a non-negative integer");
  const { genericStopDocuments: stop, genericCalibrationDocuments: calibration } = CORPUS_FAMILY_ADMISSION_V2;
  return Math.max(stop, Math.floor((stop * documentCount + calibration - 1) / calibration));
}

/** What a pinned generation says about a fingerprint — the only corpus evidence the policy reads. */
export type CorpusFamilyEvidence = {
  /** Documents in the generation: the N the generic bound is a share of. */
  documentCount: number;
  /**
   * Every non-revoked document holding the fingerprint, as identifiers that
   * are stable for the life of this view; undefined when none holds it.
   */
  holders(fingerprintHex: string): Promise<Uint32Array | undefined>;
};

export type SpanFamilyClass = "specific" | "family" | "generic";

export type SpanFamily = {
  class: SpanFamilyClass;
  /** Distinct winnowed fingerprints of the span. */
  fingerprints: number;
  /** Documents of the generation holding the span (>= spanContainmentFraction of its fingerprints). */
  holders: number;
};

/** One query's classification state: the submission's words, the evidence, and each distinct span classified once. */
export type FamilyAdmissionContext = {
  submissionWords: readonly string[];
  evidence: CorpusFamilyEvidence;
  genericDocuments: number;
  spans: Map<string, Promise<SpanFamily>>;
};

export function createFamilyAdmissionContext(submissionWords: readonly string[], evidence: CorpusFamilyEvidence): FamilyAdmissionContext {
  return { submissionWords, evidence, genericDocuments: genericFamilyDocuments(evidence.documentCount), spans: new Map() };
}

async function classify(context: FamilyAdmissionContext, start: number, end: number): Promise<SpanFamily> {
  const hashes = winnowWordSpanHashes(context.submissionWords.slice(start, end + 1));
  if (hashes.length === 0) return { class: "specific", fingerprints: 0, holders: 0 };
  // Sequential, in fingerprint order: what is read never depends on which read finished first.
  const hitsByDocument = new Map<number, number>();
  for (const hash of hashes) {
    const holders = await context.evidence.holders(hash);
    if (!holders) continue;
    for (let cursor = 0; cursor < holders.length; cursor += 1) hitsByDocument.set(holders[cursor], (hitsByDocument.get(holders[cursor]) ?? 0) + 1);
  }
  const need = CORPUS_FAMILY_ADMISSION_V2.spanContainmentFraction * hashes.length;
  let holders = 0;
  for (const count of hitsByDocument.values()) if (count >= need) holders += 1;
  const spanClass: SpanFamilyClass = holders >= context.genericDocuments ? "generic" : holders >= CORPUS_FAMILY_ADMISSION_V2.familyDocuments ? "family" : "specific";
  return { class: spanClass, fingerprints: hashes.length, holders };
}

/**
 * The family of submission words [start, end]. A span is a property of the
 * submission and the generation, not of the candidate it was verified against,
 * so the answer is computed once per query however many candidates share it.
 */
export function classifySpanFamily(context: FamilyAdmissionContext, start: number, end: number): Promise<SpanFamily> {
  const key = `${start}:${end}`;
  let pending = context.spans.get(key);
  if (!pending) {
    pending = classify(context, start, end);
    context.spans.set(key, pending);
  }
  return pending;
}

export type FamilyRole =
  /** Attributed in its own right: its dominant span is specific, or it carries independentWords of specific text. */
  | "SOURCE"
  /** No specific evidence of its own, but independentWords of non-generic text: stands for its family if nothing else covers it. */
  | "FAMILY_MEMBER"
  /** Passed STRICT_SPAN on generic text only. */
  | "GENERIC"
  | "BELOW_STRICT_SPAN";

export type FamilyAwareAdmission = SelectiveCorpusAdmissionResult & {
  role: FamilyRole;
  /** Aligned with `spans` (longest first); empty below STRICT_SPAN, where nothing is classified. */
  spanFamilies: SpanFamily[];
  /** The spans this candidate brings to the union if it is attributed: all of a SOURCE's, a FAMILY_MEMBER's non-generic ones. */
  creditedSpans: SelectiveCorpusVerifiedSpan[];
};

const strictSpan = (spans: readonly SelectiveCorpusVerifiedSpan[], totalMatchedWords: number, longestSpan: number) =>
  spans.length > 0
  && totalMatchedWords >= SELECTIVE_CORPUS_STRICT_SPAN.minMatchedWords
  && longestSpan >= SELECTIVE_CORPUS_STRICT_SPAN.minLongestContiguousSpan;

/** The matcher's passages as the admission step's spans, longest first — the statement verify.ts makes. */
export function spansOfMatchedPassages(passages: ReadonlyArray<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }> | undefined): SelectiveCorpusVerifiedSpan[] {
  return (passages ?? [])
    .map((passage) => ({ start: passage.submittedWordStart | 0, end: passage.submittedWordEnd | 0, words: passage.matchedWordCount | 0 }))
    .sort((left, right) => right.words - left.words);
}

const belowStrictSpan = (spans: SelectiveCorpusVerifiedSpan[], totalMatchedWords: number, longestSpan: number): FamilyAwareAdmission => ({
  admitted: false,
  reason: "fails STRICT_SPAN (matched words >= 60 AND longest span >= 25)",
  spans,
  totalMatchedWords,
  longestSpan,
  strictSpanPass: false,
  dominantSpanBoilerplate: false,
  familyGuardActivated: false,
  sourceSpecificWords: totalMatchedWords,
  role: "BELOW_STRICT_SPAN",
  spanFamilies: [],
  creditedSpans: [],
});

/** STRICT_SPAN and nothing else (FAMILY_ADMISSION_POLICY_STRICT_SPAN_ONLY). */
export function admitOnStrictSpanOnly(spans: SelectiveCorpusVerifiedSpan[]): FamilyAwareAdmission {
  const totalMatchedWords = spans.reduce((total, span) => total + span.words, 0);
  const longestSpan = spans.length ? spans[0].words : 0;
  if (!strictSpan(spans, totalMatchedWords, longestSpan)) return belowStrictSpan(spans, totalMatchedWords, longestSpan);
  return {
    admitted: true,
    reason: "STRICT_SPAN pass; no family rule applied (measurement)",
    spans,
    totalMatchedWords,
    longestSpan,
    strictSpanPass: true,
    dominantSpanBoilerplate: false,
    familyGuardActivated: false,
    sourceSpecificWords: totalMatchedWords,
    role: "SOURCE",
    spanFamilies: [],
    creditedSpans: spans,
  };
}

/**
 * corpus-family-admission-v2 for one candidate: STRICT_SPAN, then the role its
 * verified spans give it. `spans` are the matcher's, longest first.
 *
 * `admitted` is true for a SOURCE only. Whether a FAMILY_MEMBER is attributed
 * is a property of the whole query and is decided by
 * resolveFamilyRepresentatives.
 */
export async function admitFamilyAware(context: FamilyAdmissionContext, spans: SelectiveCorpusVerifiedSpan[]): Promise<FamilyAwareAdmission> {
  const totalMatchedWords = spans.reduce((total, span) => total + span.words, 0);
  const longestSpan = spans.length ? spans[0].words : 0;
  if (!strictSpan(spans, totalMatchedWords, longestSpan)) return belowStrictSpan(spans, totalMatchedWords, longestSpan);

  const spanFamilies: SpanFamily[] = [];
  let specificWords = 0;
  let genericWords = 0;
  for (const span of spans) {
    const family = await classifySpanFamily(context, span.start, span.end);
    spanFamilies.push(family);
    if (family.class === "specific") specificWords += span.words;
    else if (family.class === "generic") genericWords += span.words;
  }
  const dominant = spanFamilies[0];
  const shared = { spans, totalMatchedWords, longestSpan, strictSpanPass: true, sourceSpecificWords: specificWords, spanFamilies };
  const { independentWords } = CORPUS_FAMILY_ADMISSION_V2;

  if (dominant.class === "specific") {
    return { ...shared, admitted: true, reason: "STRICT_SPAN pass; dominant span is specific to this source", dominantSpanBoilerplate: false, familyGuardActivated: false, role: "SOURCE", creditedSpans: spans };
  }
  const dominantHeldBy = `dominant span held by ${dominant.holders} documents (${dominant.class})`;
  if (specificWords >= independentWords) {
    return { ...shared, admitted: true, reason: `${dominantHeldBy}; admitted on ${specificWords} source-specific verified words`, dominantSpanBoilerplate: true, familyGuardActivated: true, role: "SOURCE", creditedSpans: spans };
  }
  const nonGenericWords = totalMatchedWords - genericWords;
  if (nonGenericWords >= independentWords) {
    return {
      ...shared,
      admitted: false,
      reason: `${dominantHeldBy}; FAMILY MEMBER on ${nonGenericWords} verified words that are not generic`,
      dominantSpanBoilerplate: true,
      familyGuardActivated: true,
      role: "FAMILY_MEMBER",
      creditedSpans: spans.filter((_, index) => spanFamilies[index].class !== "generic"),
    };
  }
  return {
    ...shared,
    admitted: false,
    reason: `SUPPRESSED: ${dominantHeldBy}; only ${nonGenericWords} verified words that are not generic`,
    dominantSpanBoilerplate: true,
    familyGuardActivated: true,
    role: "GENERIC",
    creditedSpans: [],
  };
}

export type FamilyMember = { docId: string; creditedSpans: readonly SelectiveCorpusVerifiedSpan[] };

export type FamilyResolution = {
  docId: string;
  role: "REPRESENTATIVE" | "COLLAPSED";
  /** Verified positions this member holds that no source taken before it covers. */
  freshPositions: number;
  /** For a COLLAPSED member: the attributed source covering the first word of its longest credited span. */
  representedBy: string | null;
};

/** Decimal document ids in numeric order, without BigInt. */
function compareDecimalIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Which family members are attributed. The members are taken in the CANONICAL
 * ORDER
 *
 *   1. more credited verified words first,
 *   2. then the longer longest credited span,
 *   3. then the lower document id,
 *
 * and a member becomes a REPRESENTATIVE when it holds at least one verified
 * position that neither a SOURCE nor an earlier representative covers.
 * Otherwise it is COLLAPSED. The order uses nothing but the members' own
 * verified spans and ids, so the outcome does not depend on the order the
 * candidates were retrieved or verified in.
 *
 * `sources` are the candidates attributed in their own right, in any order.
 */
export function resolveFamilyRepresentatives(sources: readonly FamilyMember[], members: readonly FamilyMember[]): FamilyResolution[] {
  const coveredBy = new Map<number, string>();
  const cover = (member: FamilyMember) => {
    for (const span of member.creditedSpans) for (let position = span.start; position <= span.end; position += 1) if (!coveredBy.has(position)) coveredBy.set(position, member.docId);
  };
  for (const source of [...sources].sort((left, right) => compareDecimalIds(left.docId, right.docId))) cover(source);

  const measured = members.map((member) => ({
    member,
    words: member.creditedSpans.reduce((total, span) => total + span.words, 0),
    longest: member.creditedSpans.reduce((longest, span) => Math.max(longest, span.words), 0),
  }));
  measured.sort((left, right) => right.words - left.words || right.longest - left.longest || compareDecimalIds(left.member.docId, right.member.docId));

  const resolutions: FamilyResolution[] = [];
  for (const { member } of measured) {
    let freshPositions = 0;
    for (const span of member.creditedSpans) for (let position = span.start; position <= span.end; position += 1) if (!coveredBy.has(position)) freshPositions += 1;
    if (freshPositions > 0) {
      cover(member);
      resolutions.push({ docId: member.docId, role: "REPRESENTATIVE", freshPositions, representedBy: null });
      continue;
    }
    const longest = member.creditedSpans.reduce<SelectiveCorpusVerifiedSpan | null>((best, span) => (best === null || span.words > best.words ? span : best), null);
    resolutions.push({ docId: member.docId, role: "COLLAPSED", freshPositions: 0, representedBy: longest ? coveredBy.get(longest.start) ?? null : null });
  }
  return resolutions;
}
