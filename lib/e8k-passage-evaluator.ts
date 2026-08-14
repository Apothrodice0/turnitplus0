import { grams, gramHash, informativeGram, tokens } from "./similarity-core";
import { documentShingleHashes } from "./document-family";
import {
  computeDocumentCorrespondence,
  DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
  type DocumentCorrespondenceThresholds,
  type CorrespondencePassage,
} from "./document-correspondence";

/**
 * Phase E8K: a pure, experimental passage-level diagnostic evaluator —
 * independent of the production matcher (lib/user-submission-matching.ts,
 * never imported here) and independent of any accept/reject decision (see
 * lib/e8k-passage-acceptance.ts for that, deliberately a separate module).
 *
 * This file answers one narrow question per candidate: "is there a
 * substantial, distinctive reused passage in here?" — never "is the whole
 * document highly similar?" (that remains
 * lib/document-correspondence.ts's/lib/user-submission-matching.ts's job,
 * completely unmodified). It does so by REUSING computeDocumentCorrespondence
 * for the actual shingle/passage mechanics (E8J's finding was about
 * *decisions* made on top of correct passage data, not about the passage
 * data itself being wrong) and layering a small set of additional,
 * documented metrics on top: coverage, density, and a bounded local
 * distinctiveness score. No new shingling algorithm exists here.
 *
 * No DB access, no I/O, fully deterministic. Never touches
 * report.score/archiveScore/aiScore/verified similarity — it doesn't even
 * know those concepts exist.
 */

export type LocalCorpusDocument = { id: string; canonicalText: string };

export type PassageLevelDiagnostics = {
  /** True when lib/document-correspondence.ts's own whole-text canonical-hash short-circuit fired — an unambiguous exact (or formatting-only) match. See evaluatePassages()'s own comment on why passageCount/passageDensity are synthesized rather than left at their raw (empty) values in this case. */
  isExactCanonicalMatch: boolean;
  /** Same definition as lib/document-correspondence.ts's own field: count of submitted-document word positions covered by an accepted passage. */
  matchedWordCount: number;
  /** Number of accepted passages (each already >= thresholds.minimumPassageLengthWords). */
  passageCount: number;
  longestMatchWords: number;
  /** matchedWordCount / passageCount, 0 if passageCount is 0. */
  averagePassageLengthWords: number;
  /** matchedWordCount / submittedWordCount — how much of the CURRENT document the matched passages account for. */
  passageCoverage: number;
  /**
   * matchedWordCount / (span of the envelope from the first to the last
   * matched word position, inclusive) — how tightly the matched words are
   * clustered together, as opposed to scattered across the document. One
   * single contiguous passage scores 1.0; the same total matchedWordCount
   * spread thinly across a much larger envelope scores lower. 0 if
   * passageCount is 0.
   */
  passageDensity: number;
  /** Count of distinct informative shingles shared between the two texts — lib/document-correspondence.ts's own overlapSharedShingleCount, surfaced directly (not recomputed). */
  informativeSharedShingleCount: number;
  /**
   * Bounded 0..1 local rarity/distinctiveness score — see
   * computeDistinctiveness() below for the exact formula. "local" because it
   * is only ever computed against whatever small LocalCorpusDocument[] the
   * caller supplies (this phase's own calibration fixtures, never a real
   * corpus-wide index) — see this phase's own task description, section 15.
   */
  distinctiveness: number;
  distinctivenessBand: "low" | "medium" | "high";
  /** lib/document-correspondence.ts's own containment (shared / min(submitted, external) shingle count) — surfaced for side-by-side comparison, never recomputed differently. */
  wholeDocumentContainment: number;
  /** Reconstructed from the CURRENT submission's own words only — same privacy property as lib/document-correspondence.ts's own passages (see that file's header comment). Never the candidate/historical text. */
  passages: CorrespondencePassage[];
};

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Local rarity: for each informative shingle shared between the submission
 * and the candidate, checks how many of the OTHER supplied local corpus
 * documents also contain it. A shingle unique to the true source scores
 * high; boilerplate that recurs across most of the local corpus scores low.
 * Returns 1 (maximally rare) when there is nothing to compare against —
 * deliberately permissive rather than penalizing a caller who supplied no
 * corpus context.
 */
function corpusRarity(sharedShingles: Set<string>, otherDocs: LocalCorpusDocument[], shingleSize: number): number {
  if (sharedShingles.size === 0) return 0;
  if (otherDocs.length === 0) return 1;
  const otherShingleSets = otherDocs.map((d) => documentShingleHashes(d.canonicalText, shingleSize));
  let totalOtherHits = 0;
  for (const hash of sharedShingles) {
    totalOtherHits += otherShingleSets.filter((set) => set.has(hash)).length;
  }
  const maxPossibleHits = sharedShingles.size * otherDocs.length;
  return maxPossibleHits === 0 ? 1 : 1 - totalOtherHits / maxPossibleHits;
}

/**
 * Penalizes shingles that recur many times WITHIN the submitted document
 * itself (e.g. a boilerplate disclaimer repeated several times) — a shingle
 * seen once scores 1.0; four or more occurrences bottoms out at 0. Returns
 * 1 when there are no shared shingles to evaluate (nothing to penalize).
 */
function internalRepetitionScore(submittedText: string, sharedShingles: Set<string>, shingleSize: number): number {
  if (sharedShingles.size === 0) return 1;
  const words = tokens(submittedText);
  const counts = new Map<string, number>();
  for (const gram of grams(words, shingleSize)) {
    if (!informativeGram(gram)) continue;
    const hash = gramHash(gram);
    if (!sharedShingles.has(hash)) continue;
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  if (counts.size === 0) return 1;
  const avgOccurrences = average([...counts.values()]);
  return Math.max(0, 1 - (avgOccurrences - 1) / 3);
}

/** Rewards one long contiguous match over many tiny fragments totaling the same word count. Saturates at referenceLengthWords. */
function contiguityBonus(longestMatchWords: number, referenceLengthWords = 150): number {
  return Math.min(1, longestMatchWords / referenceLengthWords);
}

function distinctivenessBand(score: number): "low" | "medium" | "high" {
  if (score >= 0.66) return "high";
  if (score >= 0.33) return "medium";
  return "low";
}

export type EvaluatePassagesOptions = {
  thresholds?: DocumentCorrespondenceThresholds;
  /** Other historical documents for the local rarity measure — see corpusRarity() above. Pass [] for a neutral (maximally permissive) distinctiveness computation. */
  localCorpusContext?: LocalCorpusDocument[];
};

/**
 * The evaluator's single entry point. Reuses computeDocumentCorrespondence
 * for every shingle/passage mechanic (submittedShingles, externalShingles,
 * accepted spans, passage reconstruction) — this function never re-tokenizes
 * or re-shingles independently. It deliberately ignores that result's own
 * strongCorrespondence/exactCanonicalMatch booleans (those encode the
 * WHOLE-DOCUMENT decision this phase is explicitly trying to route around)
 * and instead derives its own, additional passage-level metrics from the
 * same underlying passages/matchedWordCount/shingle data.
 */
export function evaluatePassages(
  submittedText: string,
  candidateText: string,
  options: EvaluatePassagesOptions = {},
): PassageLevelDiagnostics {
  const thresholds = options.thresholds ?? DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS;
  const localCorpusContext = options.localCorpusContext ?? [];

  const correspondence = computeDocumentCorrespondence(submittedText, candidateText, thresholds);
  const submittedWordCount = correspondence.submittedWordCount;

  // lib/document-correspondence.ts's own exact-canonical-match short-circuit
  // (whole-text hash equality) deliberately returns passages: [] — an exact
  // match doesn't need itemizing, the WHOLE document is the match. Treated
  // literally, that would make this evaluator's passage-count-dependent
  // metrics read as "no passage evidence" for the single most obvious case
  // there is — exactly the disagreement this phase's own task description
  // (sections 5/6) says must not happen. Synthesized as one full-document
  // passage here, in this new module only — document-correspondence.ts
  // itself is untouched.
  const isExactCanonicalMatch = correspondence.exactCanonicalMatch;
  const passageCount = isExactCanonicalMatch ? 1 : correspondence.passages.length;
  const matchedWordCount = correspondence.matchedWordCount;
  const longestMatchWords = correspondence.longestMatchWords;
  const averagePassageLengthWords = passageCount === 0 ? 0 : matchedWordCount / passageCount;
  const passageCoverage = submittedWordCount === 0 ? 0 : matchedWordCount / submittedWordCount;

  let passageDensity = 0;
  if (isExactCanonicalMatch) {
    passageDensity = 1; // the entire document matched — maximally dense by definition
  } else if (passageCount > 0) {
    const envelopeStart = Math.min(...correspondence.passages.map((p) => p.submittedWordStart));
    const envelopeEnd = Math.max(...correspondence.passages.map((p) => p.submittedWordEnd));
    const envelopeSpan = envelopeEnd - envelopeStart + 1;
    passageDensity = envelopeSpan === 0 ? 0 : matchedWordCount / envelopeSpan;
  }

  // Distinctiveness needs the actual SET of shared informative shingles, not
  // just the count computeDocumentCorrespondence already returns — recomputed
  // here via the same documentShingleHashes() primitive that function itself
  // uses (lib/document-family.ts), not a new algorithm.
  const submittedShingles = documentShingleHashes(submittedText, thresholds.shingleSize);
  const candidateShingles = documentShingleHashes(candidateText, thresholds.shingleSize);
  const sharedShingles = new Set<string>();
  for (const hash of submittedShingles) if (candidateShingles.has(hash)) sharedShingles.add(hash);

  const otherLocalDocs = localCorpusContext.filter((d) => d.canonicalText !== candidateText);
  const rarity = corpusRarity(sharedShingles, otherLocalDocs, thresholds.shingleSize);
  const repetition = internalRepetitionScore(submittedText, sharedShingles, thresholds.shingleSize);
  const contiguity = contiguityBonus(longestMatchWords);
  const distinctiveness = passageCount === 0 ? 0 : average([rarity, repetition, contiguity]);

  return {
    isExactCanonicalMatch,
    matchedWordCount,
    passageCount,
    longestMatchWords,
    averagePassageLengthWords,
    passageCoverage,
    passageDensity,
    informativeSharedShingleCount: correspondence.overlapSharedShingleCount,
    distinctiveness,
    distinctivenessBand: distinctivenessBand(distinctiveness),
    wholeDocumentContainment: correspondence.containment,
    passages: correspondence.passages,
  };
}
