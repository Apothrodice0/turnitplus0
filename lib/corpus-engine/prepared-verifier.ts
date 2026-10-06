import type { ComparisonResult } from "../academic-search/comparator";
import type { MatchedPassage } from "../academic-search/types";
import {
  DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
  DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION,
  GENERIC_ACADEMIC_REGISTER_DENSITY_LIMIT,
  genericAcademicRegisterDensity,
  type CorrespondencePassage,
  type DocumentCorrespondenceResult,
  type DocumentCorrespondenceThresholds,
} from "../document-correspondence";
import { documentShingleHashes } from "../document-family";
import { canonicalSha256 } from "../document-identity";
import type { SelectiveCorpusArtifact } from "../selective-corpus/artifact";
import { SELECTIVE_CORPUS_FAMILY_GUARD, SELECTIVE_CORPUS_STRICT_SPAN } from "../selective-corpus/constants";
import { winnowWordSpanHashes } from "../selective-corpus/fingerprint";
import type { SelectiveCorpusFailureCollector } from "../selective-corpus/shard-reader";
import type { SelectiveCorpusAdmissionResult, SelectiveCorpusVerifiedSpan } from "../selective-corpus/verify";
import {
  acceptedSimilaritySpans,
  containment,
  currentScoringNormalizationVersion,
  gramHash,
  grams,
  informativeGram,
  tokens,
  type ScoringNormalizationVersion,
  type SimilaritySpan,
} from "../similarity-core";

/**
 * Corpus Engine v1 — the existing verifier with the submission prepared ONCE
 * per query.
 *
 * The existing verifier takes two texts. Called once per candidate, it derives
 * the same things from the submission every time:
 *
 *   tokens(submission)                          three times (word count, shingle set, match loop)
 *   canonicalSha256(submission)                 once
 *   informativeGram + gramHash per submission 5-gram   twice (shingle set, match loop)
 *
 * None of that depends on the candidate. prepareSubmissionForVerification
 * computes it once, and the three functions below run the verifier's own
 * per-candidate statements against it:
 *
 *   correspondPreparedSubmission             = computeDocumentCorrespondence    lib/document-correspondence.ts
 *   comparePreparedSubmissionToCandidate     = compareSubmissionToExternalText  lib/academic-search/comparator.ts
 *   verifyPreparedSubmissionAgainstCandidate = admitSelectiveCorpusCandidate    lib/selective-corpus/verify.ts
 *
 * THIS IS NOT A SECOND MATCHER, AND IT IS NOT THE AUTHORITY. Those three files
 * are unmodified and stay the definition of the behaviour; verifier-adapter.ts
 * still runs them as verifierPath "oracle". The functions here restate their
 * statements, in their order, over the same imported primitives (tokens, grams,
 * informativeGram, gramHash, documentShingleHashes, canonicalSha256,
 * acceptedSimilaritySpans, containment, winnowWordSpanHashes) and the same
 * imported constants. One value is copied because its owner does not export
 * it: EXACT_MATCH_PASSAGE_PREVIEW_WORDS.
 *
 * A restatement can drift from what it restates. The gate against that is
 * tests/corpus-engine-prepared-verifier.test.mjs: every result of every
 * function here must be deep-equal to the oracle's on the same inputs, and the
 * three oracle source files are pinned by hash there, so an edit to any of them
 * fails the gate until the equivalence has been proven again.
 *
 * WHAT A PREPARED SUBMISSION IS BOUND TO
 *
 * Everything that decides the derived data, and how each is kept from being
 * mixed with another contract:
 *
 *   scoring normalization   A runtime scope (lib/scoring-normalization-scope.ts)
 *                           selects v1 or v2, so the version in force at
 *                           preparation is recorded and every use is refused
 *                           under any other: the candidate would be tokenized
 *                           under a different contract than the submission was.
 *   shingle size            The only threshold baked into the derived data
 *                           (which n-grams were hashed). Recorded, and checked
 *                           against the thresholds object on every use.
 *   the other thresholds    Not baked in. They are read at verification time
 *                           from the thresholds object the submission was
 *                           prepared with — the object the oracle reads — and
 *                           no function here accepts thresholds of its own, so
 *                           a prepared submission cannot be verified under
 *                           thresholds other than the ones it carries.
 *   reference-section strip, informativeGram / COMMON_WORDS, gramHash,
 *   canonicalizeText        Properties of the running code with no runtime
 *                           switch. A prepared submission is a query-local
 *                           value: never serialized, never cached across
 *                           queries, never handed to another process. Both
 *                           halves of a verification therefore run on the same
 *                           code, and there is nothing to record.
 */

/** The contract a prepared submission was derived under. */
export type PreparedSubmissionIdentity = {
  /** The scoring normalization in force when the submission was tokenized. */
  normalizationVersion: ScoringNormalizationVersion;
  /** n of the n-grams hashed into `informativeHashes` and `shingles`. */
  shingleSize: number;
  /** lib/document-correspondence.ts's thresholds version at preparation. */
  thresholdsVersion: string;
};

/**
 * What the existing verifier derives from the submission alone. Each field is
 * exactly the value the oracle computes for the same text under the same
 * contract — nothing here is new information.
 */
export type PreparedSubmission = {
  readonly identity: PreparedSubmissionIdentity;
  /** The text this was prepared from, so a caller holding both can show they belong together. */
  readonly submissionText: string;
  /** The thresholds the comparison runs under, by reference: the same object the oracle would be passed. */
  readonly thresholds: DocumentCorrespondenceThresholds;
  /** tokens(submissionText). */
  readonly words: readonly string[];
  /** canonicalSha256(submissionText). */
  readonly canonicalSha256: string;
  /** Per n-gram start position: gramHash of the n-gram when informativeGram accepts it, else null. */
  readonly informativeHashes: ReadonlyArray<string | null>;
  /** documentShingleHashes(submissionText, shingleSize): the distinct non-null entries above, in first-occurrence order. */
  readonly shingles: ReadonlySet<string>;
};

export class PreparedSubmissionContractError extends Error {
  readonly code: "PREPARED_NORMALIZATION_MISMATCH" | "PREPARED_SHINGLE_SIZE_MISMATCH" | "PREPARED_THRESHOLDS_MISMATCH" | "PREPARED_SUBMISSION_MISMATCH";
  constructor(code: PreparedSubmissionContractError["code"], message: string) {
    super(message);
    this.name = "PreparedSubmissionContractError";
    this.code = code;
  }
}

/**
 * Everything the verifier derives from the submission, computed once. Runs
 * under the scoring normalization in force here, like tokens() itself.
 */
export function prepareSubmissionForVerification(
  submissionText: string,
  thresholds: DocumentCorrespondenceThresholds = DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
): PreparedSubmission {
  const words = tokens(submissionText);
  const submittedGrams = grams(words, thresholds.shingleSize);
  const informativeHashes = new Array<string | null>(submittedGrams.length);
  const shingles = new Set<string>();
  for (let index = 0; index < submittedGrams.length; index += 1) {
    const gram = submittedGrams[index];
    if (!informativeGram(gram)) {
      informativeHashes[index] = null;
      continue;
    }
    const hash = gramHash(gram);
    informativeHashes[index] = hash;
    shingles.add(hash);
  }
  return {
    identity: {
      normalizationVersion: currentScoringNormalizationVersion(),
      shingleSize: thresholds.shingleSize,
      thresholdsVersion: DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION,
    },
    submissionText,
    thresholds,
    words,
    canonicalSha256: canonicalSha256(submissionText),
    informativeHashes,
    shingles,
  };
}

/** Refuses a prepared submission the current computation is not entitled to use. */
function assertPreparedSubmissionContract(prepared: PreparedSubmission) {
  const ambient = currentScoringNormalizationVersion();
  if (ambient !== prepared.identity.normalizationVersion) {
    throw new PreparedSubmissionContractError(
      "PREPARED_NORMALIZATION_MISMATCH",
      `the submission was prepared under scoring normalization v${prepared.identity.normalizationVersion}; the candidate would be tokenized under v${ambient}`,
    );
  }
  if (prepared.thresholds.shingleSize !== prepared.identity.shingleSize) {
    throw new PreparedSubmissionContractError(
      "PREPARED_SHINGLE_SIZE_MISMATCH",
      `the submission was prepared with ${prepared.identity.shingleSize}-grams; its thresholds now ask for ${prepared.thresholds.shingleSize}-grams`,
    );
  }
}

/** admitSelectiveCorpusCandidate always compares under the default thresholds, so only a submission prepared with them may be admitted. */
function assertAdmissionContract(prepared: PreparedSubmission) {
  assertPreparedSubmissionContract(prepared);
  if (prepared.thresholds !== DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS) {
    throw new PreparedSubmissionContractError(
      "PREPARED_THRESHOLDS_MISMATCH",
      "candidate admission compares under DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS; this submission was prepared with other thresholds",
    );
  }
}

/**
 * For a caller that was HANDED a prepared submission: it must be this
 * submission's, usable under the contract in force, and admissible.
 */
export function assertPreparedSubmissionForAdmission(prepared: PreparedSubmission, submissionText: string) {
  if (prepared.submissionText !== submissionText) {
    throw new PreparedSubmissionContractError("PREPARED_SUBMISSION_MISMATCH", "the prepared submission was derived from a different text than the one being verified");
  }
  assertAdmissionContract(prepared);
}

/** lib/document-correspondence.ts emptyResult, restated (it is not exported). */
function emptyResult(
  method: DocumentCorrespondenceResult["method"],
  submittedWordCount: number,
  externalWordCount: number,
  thresholds: DocumentCorrespondenceThresholds,
  overrides: Partial<DocumentCorrespondenceResult> = {},
): DocumentCorrespondenceResult {
  return {
    method,
    containment: 0,
    sourceConcentration: 0,
    overlapSharedShingleCount: 0,
    matchedWordCount: 0,
    submittedWordCount,
    externalWordCount,
    longestMatchWords: 0,
    passages: [],
    allMatchedPassages: [],
    thresholds,
    thresholdsVersion: DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION,
    exactCanonicalMatch: false,
    strongCorrespondence: false,
    distinctivePassageMatch: false,
    ...overrides,
  };
}

/**
 * computeDocumentCorrespondence(prepared.submissionText, externalText,
 * prepared.thresholds), with every submission-only value read from `prepared`
 * instead of recomputed. The candidate side is computed exactly as the oracle
 * computes it.
 */
export function correspondPreparedSubmission(prepared: PreparedSubmission, externalText: string): DocumentCorrespondenceResult {
  assertPreparedSubmissionContract(prepared);
  const { thresholds } = prepared;
  const submittedWords = prepared.words;
  const submittedWordCount = submittedWords.length;
  const externalWordCount = tokens(externalText).length;

  if (submittedWordCount === 0 || externalWordCount === 0) {
    return emptyResult("shingle_containment", submittedWordCount, externalWordCount, thresholds);
  }

  if (prepared.canonicalSha256 === canonicalSha256(externalText)) {
    return emptyResult("canonical_hash", submittedWordCount, externalWordCount, thresholds, {
      containment: 1,
      sourceConcentration: 1,
      matchedWordCount: submittedWordCount,
      longestMatchWords: submittedWordCount,
      exactCanonicalMatch: true,
      strongCorrespondence: true,
    });
  }

  const submittedShingles = prepared.shingles;
  const externalShingles = documentShingleHashes(externalText, thresholds.shingleSize);
  if (submittedShingles.size === 0 || externalShingles.size === 0) {
    return emptyResult("shingle_containment", submittedWordCount, externalWordCount, thresholds);
  }

  let sharedCount = 0;
  for (const hash of submittedShingles) if (externalShingles.has(hash)) sharedCount += 1;

  // The oracle's match loop: an informative n-gram whose hash the candidate holds marks its n positions.
  const matchedPositions = new Set<number>();
  const submittedHashes = prepared.informativeHashes;
  for (let index = 0; index < submittedHashes.length; index += 1) {
    const hash = submittedHashes[index];
    if (hash === null) continue;
    if (!externalShingles.has(hash)) continue;
    for (let position = index; position < index + thresholds.shingleSize; position += 1) matchedPositions.add(position);
  }

  const { acceptedGlobalSpans, acceptedPositions } = acceptedSimilaritySpans(
    new Map([[0, matchedPositions]]),
    thresholds.minimumPassageLengthWords,
  );

  const allMatchedPassages: CorrespondencePassage[] = acceptedGlobalSpans
    .map(([start, end]): CorrespondencePassage => {
      const words = submittedWords.slice(start, Math.min(end + 1, start + thresholds.maxPassageWords));
      return {
        submittedText: words.join(" "),
        submittedWordStart: start,
        submittedWordEnd: end,
        externalWordStart: null,
        matchedWordCount: end - start + 1,
      };
    })
    .sort((a, b) => b.matchedWordCount - a.matchedWordCount);
  const passages = allMatchedPassages.slice(0, thresholds.maxPassages);

  let longestSpan: SimilaritySpan | null = null;
  const longestMatchWords = acceptedGlobalSpans.reduce((max, span) => {
    const length = span[1] - span[0] + 1;
    if (length > max) longestSpan = span;
    return Math.max(max, length);
  }, 0);
  const overallContainment = containment(sharedCount, submittedShingles.size, externalShingles.size);
  const sourceConcentration = sharedCount / Math.max(1, externalShingles.size);
  const strongCorrespondence = overallContainment >= thresholds.strongContainmentThreshold
    && acceptedPositions.size >= thresholds.minimumMatchedWords;
  const longestSpanWords = longestSpan ? submittedWords.slice(longestSpan[0], longestSpan[1] + 1) : [];
  const distinctivePassageMatch = thresholds.minimumDistinctivePassageWords !== undefined
    && longestMatchWords >= thresholds.minimumDistinctivePassageWords
    && genericAcademicRegisterDensity(longestSpanWords) < GENERIC_ACADEMIC_REGISTER_DENSITY_LIMIT;

  return {
    method: "shingle_containment",
    containment: overallContainment,
    sourceConcentration,
    overlapSharedShingleCount: sharedCount,
    matchedWordCount: acceptedPositions.size,
    submittedWordCount,
    externalWordCount,
    longestMatchWords,
    passages,
    allMatchedPassages,
    thresholds,
    thresholdsVersion: DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION,
    exactCanonicalMatch: false,
    strongCorrespondence,
    distinctivePassageMatch,
  };
}

/** lib/academic-search/comparator.ts's module-private constant of the same name and value. */
const EXACT_MATCH_PASSAGE_PREVIEW_WORDS = 60;

/** compareSubmissionToExternalText(prepared.submissionText, externalText, prepared.thresholds). */
export function comparePreparedSubmissionToCandidate(prepared: PreparedSubmission, externalText: string): ComparisonResult {
  const result = correspondPreparedSubmission(prepared, externalText);
  const matchedPassages: MatchedPassage[] = result.allMatchedPassages.length > 0
    ? result.allMatchedPassages.map((passage) => ({
      submittedText: passage.submittedText,
      submittedWordStart: passage.submittedWordStart,
      submittedWordEnd: passage.submittedWordEnd,
      matchedWordCount: passage.matchedWordCount,
    }))
    : result.exactCanonicalMatch && result.matchedWordCount > 0
      ? [{
        submittedText: prepared.words.slice(0, EXACT_MATCH_PASSAGE_PREVIEW_WORDS).join(" "),
        submittedWordStart: 0,
        submittedWordEnd: result.matchedWordCount - 1,
        matchedWordCount: result.matchedWordCount,
      }]
      : [];
  return {
    similarity: Math.round(result.containment * 100),
    matchedPassages,
    strongMatch: result.strongCorrespondence,
    exactMatch: result.exactCanonicalMatch,
  };
}

type SpanFamily = { isBoilerplate: boolean; distinctDocs: number; stopFraction: number };

/** lib/selective-corpus/verify.ts classifySpanFamily, restated (it is not exported). */
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
    return { isBoilerplate: true, distinctDocs: 13, stopFraction: +stopFraction.toFixed(3) };
  }
  const nonStop = hashes.filter((h) => !artifact.stopHashes.has(h));
  if (nonStop.length < SELECTIVE_CORPUS_FAMILY_GUARD.minSpanFingerprints) {
    return { isBoilerplate: false, distinctDocs: 0, stopFraction: +stopFraction.toFixed(3) };
  }
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

/**
 * admitSelectiveCorpusCandidate(prepared.submissionText, prepared.words,
 * candidateText, artifact, collector): the comparison, then STRICT_SPAN, then
 * FAMILY_GUARD. FAMILY_GUARD reads the artifact exactly as the oracle does —
 * the same hashes, in the same order.
 */
export async function verifyPreparedSubmissionAgainstCandidate(
  prepared: PreparedSubmission,
  candidateText: string,
  artifact: SelectiveCorpusArtifact,
  collector?: SelectiveCorpusFailureCollector,
): Promise<SelectiveCorpusAdmissionResult> {
  assertAdmissionContract(prepared);
  const submissionWords = prepared.words;
  const cmp = comparePreparedSubmissionToCandidate(prepared, candidateText);
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
