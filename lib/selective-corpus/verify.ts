import { tokens } from "../similarity-core";
import { compareSubmissionToExternalText } from "../academic-search/comparator";
import type { SelectiveCorpusArtifact } from "./artifact";
import { winnowWordSpanHashes } from "./fingerprint";
import { SELECTIVE_CORPUS_STRICT_SPAN, SELECTIVE_CORPUS_FAMILY_GUARD } from "./constants";
import type { SelectiveCorpusFailureCollector } from "./shard-reader";

/**
 * Selective Corpus V1 SHADOW slice — Stage B admission adapters.
 *
 * The matcher is the UNMODIFIED lib/academic-search/comparator.ts
 * compareSubmissionToExternalText (a thin wrapper over
 * lib/document-correspondence.ts computeDocumentCorrespondence). This module
 * does NOT re-implement shingle matching — it only applies the two frozen
 * admission gates on top of the matcher's own output:
 *
 *   STRICT_SPAN  (minority-evidence-admission run, policy E)
 *   FAMILY_GUARD (strict-span-family-final run, frozen sha256 01deb1e0…)
 *
 * Co-source attribution is lib/selective-corpus/co-source.ts, applied by the
 * orchestrator over the admitted set.
 *
 * FINGERPRINT HITS NEVER SCORE. The artifact's packed index is consulted here
 * ONLY to answer "does this verified span recur across >= 3 indexed docs" for
 * FAMILY_GUARD — a boilerplate signal, never a similarity contribution.
 */

export type SelectiveCorpusVerifiedSpan = { start: number; end: number; words: number };

export type SelectiveCorpusAdmissionResult = {
  admitted: boolean;
  reason: string;
  spans: SelectiveCorpusVerifiedSpan[];
  totalMatchedWords: number;
  longestSpan: number;
  strictSpanPass: boolean;
  dominantSpanBoilerplate: boolean;
  familyGuardActivated: boolean;
  sourceSpecificWords: number;
};

type SpanFamily = { isBoilerplate: boolean; distinctDocs: number; stopFraction: number };

/** Does the submission span [start,end] recur across >= 3 distinct indexed
 *  documents? Uses artifact fingerprint/index evidence only — no source
 *  labels, no ground truth. Identical to the strict-span-family-final run. */
async function classifySpanFamily(
  submissionWords: readonly string[],
  start: number,
  end: number,
  artifact: SelectiveCorpusArtifact,
  collector?: SelectiveCorpusFailureCollector,
): Promise<SpanFamily> {
  const hashes = winnowWordSpanHashes(submissionWords.slice(start, end + 1));
  const n = hashes.length;
  if (n === 0) return { isBoilerplate: false, distinctDocs: 0, stopFraction: 0 };

  const stopHits = hashes.filter((h) => artifact.stopHashes.has(h)).length;
  const stopFraction = stopHits / n;
  if (stopFraction >= SELECTIVE_CORPUS_FAMILY_GUARD.stopFractionBoilerplate) {
    // the span's own n-grams are provably in >= SELECTIVE_CORPUS_STOP_DF docs
    return { isBoilerplate: true, distinctDocs: 13, stopFraction: +stopFraction.toFixed(3) };
  }
  const nonStop = hashes.filter((h) => !artifact.stopHashes.has(h));
  if (nonStop.length < SELECTIVE_CORPUS_FAMILY_GUARD.minSpanFingerprints) {
    return { isBoilerplate: false, distinctDocs: 0, stopFraction: +stopFraction.toFixed(3) };
  }
  // Sequential — same determinism rationale as stage-a.ts's own postings loop.
  const hitByDoc = new Map<number, number>();
  for (const h of nonStop) {
    const arr = await artifact.postingsAccessor.getPostings(h, collector);
    if (!arr) continue;
    for (const ord of arr) hitByDoc.set(ord, (hitByDoc.get(ord) ?? 0) + 1);
  }
  const need = SELECTIVE_CORPUS_FAMILY_GUARD.spanContainmentFraction * nonStop.length;
  let distinctDocs = 0;
  for (const [, c] of hitByDoc) if (c >= need) distinctDocs += 1;
  return {
    isBoilerplate: distinctDocs >= SELECTIVE_CORPUS_FAMILY_GUARD.dominantSpanFamilyDocThreshold,
    distinctDocs,
    stopFraction: +stopFraction.toFixed(3),
  };
}

export async function admitSelectiveCorpusCandidate(
  submissionText: string,
  submissionWords: readonly string[],
  candidateText: string,
  artifact: SelectiveCorpusArtifact,
  /** The CALLING evaluation's own failure collector (see shard-reader.ts) —
   *  any packed-shard read FAMILY_GUARD depends on is attributed there.
   *  Optional so existing direct callers (the source-coverage classifier,
   *  equivalence tests) that do not care about degradation attribution are
   *  unaffected. */
  collector?: SelectiveCorpusFailureCollector,
): Promise<SelectiveCorpusAdmissionResult> {
  const cmp = compareSubmissionToExternalText(submissionText, candidateText);
  const spans: SelectiveCorpusVerifiedSpan[] = (cmp.matchedPassages ?? [])
    .map((p) => ({ start: p.submittedWordStart | 0, end: p.submittedWordEnd | 0, words: p.matchedWordCount | 0 }))
    .sort((a, b) => b.words - a.words);
  const totalMatchedWords = spans.reduce((s, x) => s + x.words, 0);
  const longestSpan = spans.length ? spans[0].words : 0;

  const strictSpanPass =
    spans.length > 0 &&
    totalMatchedWords >= SELECTIVE_CORPUS_STRICT_SPAN.minMatchedWords &&
    longestSpan >= SELECTIVE_CORPUS_STRICT_SPAN.minLongestContiguousSpan;

  if (!strictSpanPass) {
    return {
      admitted: false,
      reason: "fails STRICT_SPAN (matched words >= 60 AND longest span >= 25)",
      spans,
      totalMatchedWords,
      longestSpan,
      strictSpanPass: false,
      dominantSpanBoilerplate: false,
      familyGuardActivated: false,
      sourceSpecificWords: totalMatchedWords,
    };
  }

  let boilerplateWords = 0;
  let dominantSpanBoilerplate = false;
  // for-of, not .forEach, so each classification can be awaited in order —
  // spans are already sorted `words desc` above, so index 0 is still the
  // dominant span exactly as before.
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const fam = await classifySpanFamily(submissionWords, sp.start, sp.end, artifact, collector);
    if (fam.isBoilerplate) {
      boilerplateWords += sp.words;
      if (i === 0) dominantSpanBoilerplate = true;
    }
  }
  const sourceSpecificWords = totalMatchedWords - boilerplateWords;

  if (!dominantSpanBoilerplate) {
    return {
      admitted: true,
      reason: "STRICT_SPAN pass; dominant span not shared-family",
      spans,
      totalMatchedWords,
      longestSpan,
      strictSpanPass: true,
      dominantSpanBoilerplate: false,
      familyGuardActivated: false,
      sourceSpecificWords,
    };
  }
  // dominant span is shared-family boilerplate — admit only on independent
  // source-specific evidence
  const admitted = sourceSpecificWords >= SELECTIVE_CORPUS_FAMILY_GUARD.additionalSourceSpecificWords;
  return {
    admitted,
    reason: admitted
      ? `dominant span shared-family boilerplate; admitted on ${sourceSpecificWords} source-specific verified words`
      : `SUPPRESSED: dominant span shared-family boilerplate; only ${sourceSpecificWords} source-specific verified words`,
    spans,
    totalMatchedWords,
    longestSpan,
    strictSpanPass: true,
    dominantSpanBoilerplate: true,
    familyGuardActivated: true,
    sourceSpecificWords,
  };
}

/** Convenience: tokenise the submission once for the caller. */
export function selectiveCorpusSubmissionWords(submissionText: string): string[] {
  return tokens(submissionText);
}
