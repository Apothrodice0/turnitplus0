import { performance } from "node:perf_hooks";
import type { SelectiveCorpusArtifact } from "../selective-corpus/artifact";
import { disambiguateSelectiveCorpusCoSources } from "../selective-corpus/co-source";
import { SELECTIVE_CORPUS_STOP_DF } from "../selective-corpus/constants";
import {
  admitSelectiveCorpusCandidate,
  selectiveCorpusSubmissionWords,
  type SelectiveCorpusVerifiedSpan,
} from "../selective-corpus/verify";
import { currentScoringNormalizationVersion, mergeAdjacentPositions } from "../similarity-core";
import { computeUnifiedSimilarity } from "../unified-similarity";
import type { HighDocumentFrequencyTable } from "./generation";
import { docIdToDecimal, fingerprintFromHex } from "./ids";
import type { CorpusGenerationReader, CorpusReaderIdentity } from "./reader";
import { toSegmentError, type SegmentReader } from "./segment";

/**
 * Corpus Engine v1 — the adapter onto the EXISTING verifier.
 *
 *   candidate document id
 *     -> source text from the text pack
 *     -> admitSelectiveCorpusCandidate         lib/selective-corpus/verify.ts   (UNCHANGED)
 *          = compareSubmissionToExternalText + STRICT_SPAN + FAMILY_GUARD
 *     -> disambiguateSelectiveCorpusCoSources  lib/selective-corpus/co-source.ts (UNCHANGED)
 *     -> computeUnifiedSimilarity              lib/unified-similarity.ts        (UNCHANGED)
 *
 * There is no matching logic in this file. It fetches text, calls those three
 * functions in the order lib/selective-corpus/shadow.ts already calls them,
 * and reports what they returned. Positions and the score come from them and
 * from nowhere else.
 *
 * The one thing the verifier needs from a corpus is FAMILY_GUARD's evidence:
 * "is this fingerprint common corpus-wide" and "which documents hold it". The
 * adapter answers both from the pinned generation by presenting it as the
 * SelectiveCorpusArtifact shape verify.ts already takes:
 *
 *   stopHashes.has(h)          df(h) >= SELECTIVE_CORPUS_STOP_DF, from the
 *                              generation's resident high-df table
 *   postingsAccessor.getPostings(h)
 *                              the documents holding h, from the engine's own
 *                              index; revoked documents excluded; absent for a
 *                              stop hash, exactly as the packed artifact omits them
 *
 * Both thresholds stay the verifier's own constants. Discovery-time
 * suppression in the ranking policy never reaches this file.
 */

export type VerifierAdapterFailure = { stage: "text-fetch" | "family-guard" | "contract"; docId: string | null; partition: number | null; segmentId: string | null; code: string; message: string };

/** Generation-backed FAMILY_GUARD stop set. Only has() is meaningful — it is never enumerated. */
class GenerationStopHashes extends Set<string> {
  constructor(private readonly table: HighDocumentFrequencyTable) {
    super();
  }

  has(hex: string): boolean {
    return this.table.get(fingerprintFromHex(hex)) >= SELECTIVE_CORPUS_STOP_DF;
  }
}

/**
 * The pinned generation, presented as the artifact shape the existing verifier
 * reads. Documents are identified to the verifier by a dense uint32 that is
 * stable for the life of the view (it only counts distinct documents).
 */
export function createVerifierArtifactView(reader: CorpusGenerationReader, failures: VerifierAdapterFailure[]): SelectiveCorpusArtifact {
  if (!reader.highDf) throw new Error(`the generation's document-frequency artifact is unavailable: ${reader.highDfFailure ?? "unknown"}`);
  if (reader.highDf.recordFloor > SELECTIVE_CORPUS_STOP_DF) {
    throw new Error(`the generation records df only from ${reader.highDf.recordFloor}; the verifier's stop test needs df >= ${SELECTIVE_CORPUS_STOP_DF}`);
  }
  const stopHashes = new GenerationStopHashes(reader.highDf);
  const bases: number[] = [];
  let total = 0;
  for (const slot of reader.slots) {
    bases.push(total);
    total += slot.reader?.documentCount ?? reader.manifest.segments[slot.segmentId].documentCount;
  }
  const reportedSlots = new Set<number>();
  const memo = new Map<string, Promise<Uint32Array | undefined>>();

  const lookup = async (hex: string): Promise<Uint32Array | undefined> => {
    if (stopHashes.has(hex)) return undefined;
    const key = fingerprintFromHex(hex);
    const holders: number[] = [];
    for (let index = 0; index < reader.slots.length; index += 1) {
      const slot = reader.slots[index];
      if (!slot.reader) {
        if (!reportedSlots.has(index)) {
          reportedSlots.add(index);
          failures.push({ stage: "family-guard", docId: null, partition: slot.partition, segmentId: slot.segmentId, code: slot.failure?.code ?? "UNREADABLE", message: slot.failure?.message ?? "segment unavailable" });
        }
        continue;
      }
      try {
        const [hit] = await (slot.reader as SegmentReader).lookupDictionary([key]);
        if (!hit) continue;
        const [ordinals] = await (slot.reader as SegmentReader).readPostings([hit]);
        for (let cursor = 0; cursor < ordinals.length; cursor += 1) {
          if (!slot.revokedOrdinals.has(ordinals[cursor])) holders.push(bases[index] + ordinals[cursor]);
        }
      } catch (error) {
        if (!reportedSlots.has(index)) {
          reportedSlots.add(index);
          const failure = toSegmentError(error, "index");
          failures.push({ stage: "family-guard", docId: null, partition: slot.partition, segmentId: slot.segmentId, code: failure.code, message: failure.message });
        }
      }
    }
    return holders.length > 0 ? Uint32Array.from(holders) : undefined;
  };

  return {
    artifactPath: `corpus-engine:${reader.generationId}`,
    corpusVersion: reader.manifest.processing.corpusFormat,
    corpusDigest: reader.logicalManifestSha256,
    fingerprintVersion: reader.manifest.processing.fingerprint.equivalentTo,
    documentCount: reader.manifest.documentCount,
    postingsAccessor: {
      getPostings(hexHash: string) {
        let pending = memo.get(hexHash);
        if (!pending) {
          pending = lookup(hexHash);
          memo.set(hexHash, pending);
        }
        return pending;
      },
      getStats() {
        return { maxShards: Infinity, shardFileReads: 0, cacheHits: 0, cacheMisses: 0, shardBytesRead: 0, residentBytes: -1, peakResidentBytes: -1, loadedShards: 0, shardLoadFailures: reportedSlots.size };
      },
    },
    stopHashes,
    docs: [],
    docByOrdinal: [],
    mode: "file-backed",
    storage: {
      async readObject(key: string): Promise<Uint8Array> {
        throw new Error(`the corpus-engine verifier view serves no Selective Corpus objects (asked for ${key})`);
      },
      async objectExists(): Promise<boolean> {
        return false;
      },
    },
  };
}

export type CandidateAdmission = {
  docId: string;
  /** Position in the order the candidates were handed in (0-based). */
  order: number;
  outcome: "ADMITTED" | "NOT_ADMITTED" | "TEXT_REVOKED" | "TEXT_NOT_FOUND" | "TEXT_FAILED";
  reason: string;
  spans: SelectiveCorpusVerifiedSpan[];
  totalMatchedWords: number;
  longestSpan: number;
  strictSpanPass: boolean;
  familyGuardActivated: boolean;
  dominantSpanBoilerplate: boolean;
  textCompressedBytesRead: number;
  textDecompressedBytes: number;
  textReadMs: number;
  textDecodeMs: number;
  verifyMs: number;
};

export type AdmissionPass = {
  identity: CorpusReaderIdentity;
  submissionWordCount: number;
  admissions: CandidateAdmission[];
  failures: VerifierAdapterFailure[];
};

/**
 * Fetches each candidate's text and runs the existing admission on it, in the
 * order given. A candidate whose text cannot be fetched is recorded as a
 * failure — it is never treated as "verified and did not match".
 */
export async function admitCandidates(
  reader: CorpusGenerationReader,
  submissionText: string,
  candidateDocIds: readonly bigint[],
  shared?: { artifact: SelectiveCorpusArtifact; failures: VerifierAdapterFailure[]; submissionWords?: string[] },
): Promise<AdmissionPass> {
  const failures = shared?.failures ?? [];
  const identity = reader.identity();
  const ambient = currentScoringNormalizationVersion();
  if (ambient !== reader.manifest.processing.normalization.version) {
    failures.push({
      stage: "contract", docId: null, partition: null, segmentId: null, code: "NORMALIZATION_CONTRACT_MISMATCH",
      message: `the verifier would tokenize under scoring normalization v${ambient}; generation ${reader.generationId} was built under v${reader.manifest.processing.normalization.version}`,
    });
    return { identity, submissionWordCount: 0, admissions: [], failures };
  }
  let artifact: SelectiveCorpusArtifact;
  try {
    artifact = shared?.artifact ?? createVerifierArtifactView(reader, failures);
  } catch (error) {
    failures.push({ stage: "contract", docId: null, partition: null, segmentId: null, code: "DF_ARTIFACT_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) });
    return { identity, submissionWordCount: 0, admissions: [], failures };
  }
  const submissionWords = shared?.submissionWords ?? selectiveCorpusSubmissionWords(submissionText);

  const admissions: CandidateAdmission[] = [];
  for (let order = 0; order < candidateDocIds.length; order += 1) {
    const docId = candidateDocIds[order];
    const decimal = docIdToDecimal(docId);
    const blank = { docId: decimal, order, spans: [], totalMatchedWords: 0, longestSpan: 0, strictSpanPass: false, familyGuardActivated: false, dominantSpanBoilerplate: false, textCompressedBytesRead: 0, textDecompressedBytes: 0, textReadMs: 0, textDecodeMs: 0, verifyMs: 0 };
    const fetched = await reader.fetchText(docId);
    if (fetched.state === "REVOKED") {
      admissions.push({ ...blank, outcome: "TEXT_REVOKED", reason: "document is revoked; its text is not served" });
      continue;
    }
    if (fetched.state === "NOT_FOUND") {
      admissions.push({ ...blank, outcome: "TEXT_NOT_FOUND", reason: "document is not in this generation" });
      failures.push({ stage: "text-fetch", docId: decimal, partition: null, segmentId: null, code: "NOT_FOUND", message: "candidate document is not in this generation" });
      continue;
    }
    if (fetched.state === "FAILED") {
      admissions.push({ ...blank, outcome: "TEXT_FAILED", reason: fetched.failure.message });
      failures.push({ stage: "text-fetch", docId: decimal, partition: fetched.failure.partition, segmentId: fetched.failure.segmentId, code: fetched.failure.code, message: fetched.failure.message });
      continue;
    }
    const verifyStarted = performance.now();
    const result = await admitSelectiveCorpusCandidate(submissionText, submissionWords, fetched.text, artifact);
    admissions.push({
      docId: decimal,
      order,
      outcome: result.admitted ? "ADMITTED" : "NOT_ADMITTED",
      reason: result.reason,
      spans: result.spans,
      totalMatchedWords: result.totalMatchedWords,
      longestSpan: result.longestSpan,
      strictSpanPass: result.strictSpanPass,
      familyGuardActivated: result.familyGuardActivated,
      dominantSpanBoilerplate: result.dominantSpanBoilerplate,
      textCompressedBytesRead: fetched.metrics.compressedBytesRead,
      textDecompressedBytes: fetched.metrics.decompressedBytes,
      textReadMs: fetched.metrics.readMs,
      textDecodeMs: fetched.metrics.decodeMs,
      verifyMs: performance.now() - verifyStarted,
    });
  }
  return { identity, submissionWordCount: submissionWords.length, admissions, failures };
}

export type VerifiedSource = {
  docId: string;
  order: number;
  /** Positions credited to this source after the existing co-source attribution. */
  attributedPositions: number;
  totalMatchedWords: number;
  longestSpan: number;
  familyGuardActivated: boolean;
  matchedPassages: Array<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }>;
};

export type CorpusVerificationResult = {
  /** COMPLETE only if every candidate's text was fetched and FAMILY_GUARD saw the whole index. */
  state: "COMPLETE" | "PARTIAL" | "FAILED";
  identity: CorpusReaderIdentity;
  submissionWordCount: number;
  candidatesVerified: number;
  verifiedSources: VerifiedSource[];
  /** The union of every admitted source's positions, from computeUnifiedSimilarity. */
  matchedPositions: number[];
  matchedWordCount: number;
  /** computeUnifiedSimilarity's unifiedScore over exactly this evidence. */
  unifiedScore: number;
  coSourceActivations: number;
  familyGuardActivations: number;
  failures: VerifierAdapterFailure[];
  totals: { textCompressedBytesRead: number; textDecompressedBytes: number; textReadMs: number; textDecodeMs: number; verifyMs: number };
};

/**
 * Co-source attribution, then the existing union and score, over admissions
 * that may have been produced by several admitCandidates passes (the
 * exhaustive reference runs them in parallel workers). `admissions` must be in
 * candidate order: co-source attribution is order-sensitive on ties.
 */
export function finalizeVerification(
  identity: CorpusReaderIdentity,
  submissionWordCount: number,
  admissions: readonly CandidateAdmission[],
  failures: readonly VerifierAdapterFailure[],
): CorpusVerificationResult {
  const totals = { textCompressedBytesRead: 0, textDecompressedBytes: 0, textReadMs: 0, textDecodeMs: 0, verifyMs: 0 };
  let familyGuardActivations = 0;
  const admittedSpans = new Map<string, SelectiveCorpusVerifiedSpan[]>();
  const admittedByKey = new Map<string, CandidateAdmission>();
  for (const admission of admissions) {
    totals.textCompressedBytesRead += admission.textCompressedBytesRead;
    totals.textDecompressedBytes += admission.textDecompressedBytes;
    totals.textReadMs += admission.textReadMs;
    totals.textDecodeMs += admission.textDecodeMs;
    totals.verifyMs += admission.verifyMs;
    if (admission.familyGuardActivated) familyGuardActivations += 1;
    if (admission.outcome === "ADMITTED") {
      admittedSpans.set(admission.docId, admission.spans);
      admittedByKey.set(admission.docId, admission);
    }
  }
  const coSource = disambiguateSelectiveCorpusCoSources(admittedSpans);
  const verifiedSources: VerifiedSource[] = [];
  for (const [docId, positions] of coSource.attributed) {
    if (positions.size === 0) continue;
    const admission = admittedByKey.get(docId) as CandidateAdmission;
    verifiedSources.push({
      docId,
      order: admission.order,
      attributedPositions: positions.size,
      totalMatchedWords: admission.totalMatchedWords,
      longestSpan: admission.longestSpan,
      familyGuardActivated: admission.familyGuardActivated,
      matchedPassages: mergeAdjacentPositions(positions).map(([start, end]) => ({ submittedWordStart: start, submittedWordEnd: end, matchedWordCount: end - start + 1 })),
    });
  }
  const unified = computeUnifiedSimilarity({
    wordCount: submissionWordCount,
    selectiveCorpusEvidence: verifiedSources.map((source) => ({ sourceId: source.docId, matchedPassages: source.matchedPassages })),
  });
  const contractFailure = failures.some((failure) => failure.stage === "contract");
  return {
    state: contractFailure ? "FAILED" : failures.length > 0 ? "PARTIAL" : "COMPLETE",
    identity,
    submissionWordCount,
    candidatesVerified: admissions.filter((admission) => admission.outcome === "ADMITTED" || admission.outcome === "NOT_ADMITTED").length,
    verifiedSources,
    matchedPositions: unified.matchedPositions,
    matchedWordCount: unified.uniqueMatchedWords,
    unifiedScore: unified.unifiedScore,
    coSourceActivations: coSource.activations,
    familyGuardActivations,
    failures: [...failures],
    totals,
  };
}

/** Candidates (in rank order) -> source text -> existing verifier -> existing union and score. */
export async function verifyCandidatesWithExistingVerifier(
  reader: CorpusGenerationReader,
  submissionText: string,
  candidateDocIds: readonly bigint[],
): Promise<CorpusVerificationResult> {
  const pass = await admitCandidates(reader, submissionText, candidateDocIds);
  return finalizeVerification(pass.identity, pass.submissionWordCount, pass.admissions, pass.failures);
}
