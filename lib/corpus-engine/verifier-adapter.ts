import { performance } from "node:perf_hooks";
import { compareSubmissionToExternalText } from "../academic-search/comparator";
import type { SelectiveCorpusArtifact } from "../selective-corpus/artifact";
import { disambiguateSelectiveCorpusCoSources } from "../selective-corpus/co-source";
import { SELECTIVE_CORPUS_STOP_DF } from "../selective-corpus/constants";
import {
  admitSelectiveCorpusCandidate,
  selectiveCorpusSubmissionWords,
  type SelectiveCorpusAdmissionResult,
  type SelectiveCorpusVerifiedSpan,
} from "../selective-corpus/verify";
import { currentScoringNormalizationVersion, mergeAdjacentPositions } from "../similarity-core";
import { computeUnifiedSimilarity } from "../unified-similarity";
import {
  admitFamilyAware,
  admitOnStrictSpanOnly,
  createFamilyAdmissionContext,
  DEFAULT_FAMILY_ADMISSION_POLICY,
  FAMILY_ADMISSION_POLICY_AWARE_V2,
  FAMILY_ADMISSION_POLICY_GUARD_V1,
  resolveFamilyRepresentatives,
  spansOfMatchedPassages,
  type CorpusFamilyEvidence,
  type FamilyAdmissionContext,
  type FamilyAdmissionPolicyId,
  type FamilyResolution,
  type FamilyRole,
  type SpanFamilyClass,
} from "./family-admission";
import { DerivedSourceError, type DerivedSourceSidecarSet, type SidecarReadMetrics } from "./derived-source";
import type { HighDocumentFrequencyTable } from "./generation";
import { docIdToDecimal, fingerprintFromHex } from "./ids";
import {
  assertPreparedSubmissionForAdmission,
  comparePreparedSubmissionToCandidate,
  comparePreparedSubmissionToDerived,
  prepareSubmissionForVerification,
  PreparedSubmissionContractError,
  verifyPreparedSubmissionAgainstCandidate,
  type PreparedSubmission,
} from "./prepared-verifier";
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
 * There is no matching logic in this file. It fetches text, runs the admission
 * step, calls co-source attribution and the union/score in the order
 * lib/selective-corpus/shadow.ts already calls them, and reports what they
 * returned. Positions and the score come from them and from nowhere else.
 *
 * THE ADMISSION STEP HAS TWO PATHS WITH ONE BEHAVIOUR (VerifierPath):
 *
 *   "oracle"               admitSelectiveCorpusCandidate itself, once per
 *                          candidate. It re-derives everything it needs from
 *                          the submission on every call.
 *   "prepared-submission"  (default) the submission is prepared once per
 *                          query and each candidate is verified against that
 *                          (./prepared-verifier.ts, which restates the same
 *                          statements over the same primitives).
 *
 * The oracle defines the result. The prepared path is only allowed to be
 * faster: tests/corpus-engine-prepared-verifier.test.mjs requires its output to
 * be identical, and the oracle stays selectable so that can be re-checked on
 * any corpus.
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
 *
 * THE FAMILY RULE IS A NAMED POLICY (FamilyAdmissionPolicyId, ./family-admission.ts),
 * separate from the matcher and from the path above:
 *
 *   "selective-family-guard-v1"     the release candidate's FAMILY_GUARD, as
 *                                   described above and exactly as verify.ts
 *                                   applies it.
 *   "corpus-family-admission-v2"    (default) the same matcher and STRICT_SPAN,
 *                                   then family-aware admission: a passage held
 *                                   by a family of sources is attributed to one
 *                                   representative instead of to nobody. It
 *                                   reads the generation through
 *                                   createFamilyEvidenceView — every holder of a
 *                                   fingerprint, with no stop set.
 *
 * Under v2 a candidate can come out of admission as a FAMILY_MEMBER. Whether a
 * member is attributed depends on the other candidates of the query, so it is
 * decided in finalizeVerification, immediately before the unchanged co-source
 * attribution, union and score.
 *
 * DERIVED SOURCE SIDECAR (./derived-source.ts, optional). On the prepared path,
 * under any policy but v1, a candidate whose segment has a sidecar is verified
 * from its sidecar entry — what the verifier derives from the text, stored —
 * and its text is not fetched. Revocation and location are checked first,
 * exactly as fetchText checks them. A missing, refused or damaged entry falls
 * back to the text, so the sidecar can make a verification faster and never
 * different.
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
 * Every non-revoked document of the pinned generation holding a fingerprint,
 * as a dense uint32 that is stable for the life of the lookup (it only counts
 * distinct documents). A segment that cannot answer is reported once, as a
 * family-guard failure, and skipped — the verification is then PARTIAL.
 */
function createHolderLookup(reader: CorpusGenerationReader, failures: VerifierAdapterFailure[]) {
  const bases: number[] = [];
  let total = 0;
  for (const slot of reader.slots) {
    bases.push(total);
    total += slot.reader?.documentCount ?? reader.manifest.segments[slot.segmentId].documentCount;
  }
  const reportedSlots = new Set<number>();

  const holdersOf = async (hex: string): Promise<Uint32Array | undefined> => {
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
  return { holdersOf, reportedSlots };
}

/**
 * The pinned generation as the evidence corpus-family-admission-v2 reads:
 * every holder of a fingerprint, common ones included. Answers are kept for
 * the life of the view, which is one query.
 */
export function createFamilyEvidenceView(reader: CorpusGenerationReader, failures: VerifierAdapterFailure[]): CorpusFamilyEvidence {
  const { holdersOf } = createHolderLookup(reader, failures);
  const memo = new Map<string, Promise<Uint32Array | undefined>>();
  return {
    documentCount: reader.manifest.documentCount,
    holders(fingerprintHex: string) {
      let pending = memo.get(fingerprintHex);
      if (!pending) {
        pending = holdersOf(fingerprintHex);
        memo.set(fingerprintHex, pending);
      }
      return pending;
    },
  };
}

/**
 * The pinned generation, presented as the artifact shape the existing verifier
 * reads (FAMILY_GUARD v1): stop fingerprints have no postings, as in the
 * packed artifact.
 */
export function createVerifierArtifactView(reader: CorpusGenerationReader, failures: VerifierAdapterFailure[]): SelectiveCorpusArtifact {
  if (!reader.highDf) throw new Error(`the generation's document-frequency artifact is unavailable: ${reader.highDfFailure ?? "unknown"}`);
  if (reader.highDf.recordFloor > SELECTIVE_CORPUS_STOP_DF) {
    throw new Error(`the generation records df only from ${reader.highDf.recordFloor}; the verifier's stop test needs df >= ${SELECTIVE_CORPUS_STOP_DF}`);
  }
  const stopHashes = new GenerationStopHashes(reader.highDf);
  const { holdersOf, reportedSlots } = createHolderLookup(reader, failures);
  const memo = new Map<string, Promise<Uint32Array | undefined>>();
  const lookup = async (hex: string): Promise<Uint32Array | undefined> => (stopHashes.has(hex) ? undefined : holdersOf(hex));

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
  /**
   * FAMILY_MEMBER occurs only under corpus-family-admission-v2: the candidate
   * holds verified, non-generic text that a family of sources shares, and
   * finalizeVerification decides whether it stands for that family.
   */
  outcome: "ADMITTED" | "FAMILY_MEMBER" | "NOT_ADMITTED" | "TEXT_REVOKED" | "TEXT_NOT_FOUND" | "TEXT_FAILED";
  reason: string;
  /** Every span the matcher verified, longest first. */
  spans: SelectiveCorpusVerifiedSpan[];
  /** The spans this candidate brings to the union if it is attributed (all of them, or a family member's non-generic ones). */
  creditedSpans: SelectiveCorpusVerifiedSpan[];
  /** v2 only: the candidate's role, and what the generation holds of its dominant span. Null under the other policies. */
  familyRole: FamilyRole | null;
  dominantSpanClass: SpanFamilyClass | null;
  dominantSpanHolders: number | null;
  totalMatchedWords: number;
  longestSpan: number;
  strictSpanPass: boolean;
  familyGuardActivated: boolean;
  dominantSpanBoilerplate: boolean;
  textCompressedBytesRead: number;
  textDecompressedBytes: number;
  textReadMs: number;
  textDecodeMs: number;
  /** Where the candidate side came from: its stored text, or its derived-source sidecar entry. */
  sourceFrom: "text" | "sidecar" | null;
  sidecarReadMs: number;
  sidecarDecodeMs: number;
  sidecarBytesRead: number;
  verifyMs: number;
};

/** Which implementation of the admission step ran. Both must produce the same result; see this file's header. */
export type VerifierPath = "prepared-submission" | "oracle";

export const DEFAULT_VERIFIER_PATH: VerifierPath = "prepared-submission";

export type AdmissionPass = {
  identity: CorpusReaderIdentity;
  submissionWordCount: number;
  admissions: CandidateAdmission[];
  failures: VerifierAdapterFailure[];
  verifierPath: VerifierPath;
  familyPolicy: FamilyAdmissionPolicyId;
  /** Time spent preparing the submission in THIS pass: 0 on the oracle path, and 0 when the caller handed in a prepared submission. */
  prepareMs: number;
};

/**
 * Fetches each candidate's text and runs the existing admission on it, in the
 * order given. A candidate whose text cannot be fetched is recorded as a
 * failure — it is never treated as "verified and did not match".
 *
 * On the prepared path the submission is prepared once here, before the first
 * candidate. A caller that makes several passes over one submission prepares
 * it itself and hands it in as `shared.preparedSubmission`; `submissionWords`
 * is then not consulted (the prepared submission carries the same words).
 *
 * `familyPolicy` names the family rule (default: the engine's). A caller that
 * makes several passes over one submission under v2 hands in one
 * `shared.familyContext`, so each distinct span is classified once.
 */
export async function admitCandidates(
  reader: CorpusGenerationReader,
  submissionText: string,
  candidateDocIds: readonly bigint[],
  shared?: { artifact?: SelectiveCorpusArtifact; familyContext?: FamilyAdmissionContext; failures: VerifierAdapterFailure[]; submissionWords?: string[]; preparedSubmission?: PreparedSubmission },
  options: { verifierPath?: VerifierPath; familyPolicy?: FamilyAdmissionPolicyId; sidecars?: DerivedSourceSidecarSet | null } = {},
): Promise<AdmissionPass> {
  const failures = shared?.failures ?? [];
  const identity = reader.identity();
  const verifierPath = options.verifierPath ?? DEFAULT_VERIFIER_PATH;
  const familyPolicy = options.familyPolicy ?? DEFAULT_FAMILY_ADMISSION_POLICY;
  const guardV1 = familyPolicy === FAMILY_ADMISSION_POLICY_GUARD_V1;
  const sidecars = options.sidecars ?? null;
  const refused = (): AdmissionPass => ({ identity, submissionWordCount: 0, admissions: [], failures, verifierPath, familyPolicy, prepareMs: 0 });
  const ambient = currentScoringNormalizationVersion();
  if (ambient !== reader.manifest.processing.normalization.version) {
    failures.push({
      stage: "contract", docId: null, partition: null, segmentId: null, code: "NORMALIZATION_CONTRACT_MISMATCH",
      message: `the verifier would tokenize under scoring normalization v${ambient}; generation ${reader.generationId} was built under v${reader.manifest.processing.normalization.version}`,
    });
    return refused();
  }
  // The v1 guard reads the generation through the artifact view (it needs the df artifact); the other policies do not.
  let artifact: SelectiveCorpusArtifact | null = null;
  if (guardV1) {
    try {
      artifact = shared?.artifact ?? createVerifierArtifactView(reader, failures);
    } catch (error) {
      failures.push({ stage: "contract", docId: null, partition: null, segmentId: null, code: "DF_ARTIFACT_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) });
      return refused();
    }
  }
  let prepared: PreparedSubmission | null = null;
  let prepareMs = 0;
  if (verifierPath === "prepared-submission") {
    if (shared?.preparedSubmission) {
      try {
        assertPreparedSubmissionForAdmission(shared.preparedSubmission, submissionText);
      } catch (error) {
        if (!(error instanceof PreparedSubmissionContractError)) throw error;
        failures.push({ stage: "contract", docId: null, partition: null, segmentId: null, code: error.code, message: error.message });
        return refused();
      }
      prepared = shared.preparedSubmission;
    } else if (candidateDocIds.length > 0) {
      const prepareStarted = performance.now();
      prepared = prepareSubmissionForVerification(submissionText);
      prepareMs = performance.now() - prepareStarted;
    }
  }
  const submissionWords: readonly string[] = prepared ? prepared.words : shared?.submissionWords ?? selectiveCorpusSubmissionWords(submissionText);
  const familyContext = familyPolicy === FAMILY_ADMISSION_POLICY_AWARE_V2
    ? shared?.familyContext ?? createFamilyAdmissionContext(submissionWords, createFamilyEvidenceView(reader, failures))
    : null;

  const admissions: CandidateAdmission[] = [];
  for (let order = 0; order < candidateDocIds.length; order += 1) {
    const docId = candidateDocIds[order];
    const decimal = docIdToDecimal(docId);
    const blank = { docId: decimal, order, spans: [], creditedSpans: [], familyRole: null, dominantSpanClass: null, dominantSpanHolders: null, totalMatchedWords: 0, longestSpan: 0, strictSpanPass: false, familyGuardActivated: false, dominantSpanBoilerplate: false, textCompressedBytesRead: 0, textDecompressedBytes: 0, textReadMs: 0, textDecodeMs: 0, sourceFrom: null, sidecarReadMs: 0, sidecarDecodeMs: 0, sidecarBytesRead: 0, verifyMs: 0 };

    // The sidecar path: same revocation rule as fetchText, then the stored derivation instead of the text.
    if (sidecars && prepared && !guardV1 && !reader.revocations.has(docId)) {
      const location = reader.locate(docId);
      const sidecarMetrics: SidecarReadMetrics = { readMs: 0, decodeMs: 0, bytesRead: 0 };
      let derived = null;
      if (location) {
        try {
          derived = await sidecars.read(location, sidecarMetrics);
        } catch (error) {
          if (!(error instanceof DerivedSourceError)) throw error;
          derived = null; // a damaged entry: verify from the text below
        }
      }
      if (derived) {
        const verifyStarted = performance.now();
        const spans = spansOfMatchedPassages(comparePreparedSubmissionToDerived(prepared, derived, sidecars.identity).matchedPassages);
        const aware = familyContext ? await admitFamilyAware(familyContext, spans) : admitOnStrictSpanOnly(spans);
        admissions.push({
          ...blank,
          outcome: aware.admitted ? "ADMITTED" : aware.role === "FAMILY_MEMBER" && familyContext ? "FAMILY_MEMBER" : "NOT_ADMITTED",
          reason: aware.reason,
          spans: aware.spans,
          creditedSpans: aware.creditedSpans,
          familyRole: familyContext ? aware.role : null,
          dominantSpanClass: familyContext ? aware.spanFamilies[0]?.class ?? null : null,
          dominantSpanHolders: familyContext ? aware.spanFamilies[0]?.holders ?? null : null,
          totalMatchedWords: aware.totalMatchedWords,
          longestSpan: aware.longestSpan,
          strictSpanPass: aware.strictSpanPass,
          familyGuardActivated: aware.familyGuardActivated,
          dominantSpanBoilerplate: aware.dominantSpanBoilerplate,
          sourceFrom: "sidecar",
          sidecarReadMs: sidecarMetrics.readMs,
          sidecarDecodeMs: sidecarMetrics.decodeMs,
          sidecarBytesRead: sidecarMetrics.bytesRead,
          verifyMs: performance.now() - verifyStarted,
        });
        continue;
      }
    }
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
    let result: SelectiveCorpusAdmissionResult;
    let creditedSpans: SelectiveCorpusVerifiedSpan[];
    let familyRole: FamilyRole | null = null;
    let dominantSpanClass: SpanFamilyClass | null = null;
    let dominantSpanHolders: number | null = null;
    if (guardV1) {
      result = prepared
        ? await verifyPreparedSubmissionAgainstCandidate(prepared, fetched.text, artifact as SelectiveCorpusArtifact)
        : await admitSelectiveCorpusCandidate(submissionText, submissionWords, fetched.text, artifact as SelectiveCorpusArtifact);
      creditedSpans = result.admitted ? result.spans : [];
    } else {
      // The matcher is the same one on both paths; only the family rule after it differs from v1.
      const comparison = prepared ? comparePreparedSubmissionToCandidate(prepared, fetched.text) : compareSubmissionToExternalText(submissionText, fetched.text);
      const spans = spansOfMatchedPassages(comparison.matchedPassages);
      const aware = familyContext ? await admitFamilyAware(familyContext, spans) : admitOnStrictSpanOnly(spans);
      result = aware;
      creditedSpans = aware.creditedSpans;
      if (familyContext) {
        familyRole = aware.role;
        dominantSpanClass = aware.spanFamilies[0]?.class ?? null;
        dominantSpanHolders = aware.spanFamilies[0]?.holders ?? null;
      }
    }
    admissions.push({
      docId: decimal,
      order,
      outcome: result.admitted ? "ADMITTED" : familyRole === "FAMILY_MEMBER" ? "FAMILY_MEMBER" : "NOT_ADMITTED",
      reason: result.reason,
      spans: result.spans,
      creditedSpans,
      familyRole,
      dominantSpanClass,
      dominantSpanHolders,
      totalMatchedWords: result.totalMatchedWords,
      longestSpan: result.longestSpan,
      strictSpanPass: result.strictSpanPass,
      familyGuardActivated: result.familyGuardActivated,
      dominantSpanBoilerplate: result.dominantSpanBoilerplate,
      textCompressedBytesRead: fetched.metrics.compressedBytesRead,
      textDecompressedBytes: fetched.metrics.decompressedBytes,
      textReadMs: fetched.metrics.readMs,
      textDecodeMs: fetched.metrics.decodeMs,
      sourceFrom: "text",
      sidecarReadMs: 0,
      sidecarDecodeMs: 0,
      sidecarBytesRead: 0,
      verifyMs: performance.now() - verifyStarted,
    });
  }
  return { identity, submissionWordCount: submissionWords.length, admissions, failures, verifierPath, familyPolicy, prepareMs };
}

export type VerifiedSource = {
  docId: string;
  order: number;
  /** Positions credited to this source after the existing co-source attribution. */
  attributedPositions: number;
  totalMatchedWords: number;
  longestSpan: number;
  familyGuardActivated: boolean;
  /** True when this source is attributed as the representative of a family of sources holding the same passage (v2). */
  familyRepresentative: boolean;
  /** v2: documents of the generation holding this source's dominant span; null under the other policies. */
  dominantSpanHolders: number | null;
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
  /** The family rule that produced the admissions; null when the caller merged passes and did not say. */
  familyPolicy: FamilyAdmissionPolicyId | null;
  /** v2: one entry per family member, in the canonical order they were resolved in. Empty under the other policies. */
  familyResolutions: FamilyResolution[];
  failures: VerifierAdapterFailure[];
  /** The admission path that produced `verifiedSources`; null when the caller merged passes and did not say. */
  verifierPath: VerifierPath | null;
  /** verifyMs is the per-candidate verification time summed; prepareMs is the once-per-query submission preparation (0 on the oracle path). */
  totals: { textCompressedBytesRead: number; textDecompressedBytes: number; textReadMs: number; textDecodeMs: number; verifyMs: number; prepareMs: number; sidecarReadMs: number; sidecarDecodeMs: number; sidecarBytesRead: number; candidatesFromSidecar: number };
};

/**
 * Co-source attribution, then the existing union and score, over admissions
 * that may have been produced by several admitCandidates passes (the
 * exhaustive reference runs them in parallel workers). `admissions` must be in
 * candidate order: co-source attribution is order-sensitive on ties.
 *
 * Family members (v2) are resolved here, over the whole query: a member is
 * attributed when it is its family's representative and collapsed otherwise
 * (resolveFamilyRepresentatives). The attributed set — sources and
 * representatives, in candidate order — is what co-source attribution, the
 * union and the score then see.
 */
export function finalizeVerification(
  identity: CorpusReaderIdentity,
  submissionWordCount: number,
  admissions: readonly CandidateAdmission[],
  failures: readonly VerifierAdapterFailure[],
  pass: { verifierPath?: VerifierPath; prepareMs?: number; familyPolicy?: FamilyAdmissionPolicyId } = {},
): CorpusVerificationResult {
  const totals = { textCompressedBytesRead: 0, textDecompressedBytes: 0, textReadMs: 0, textDecodeMs: 0, verifyMs: 0, prepareMs: pass.prepareMs ?? 0, sidecarReadMs: 0, sidecarDecodeMs: 0, sidecarBytesRead: 0, candidatesFromSidecar: 0 };
  let familyGuardActivations = 0;
  const admittedSpans = new Map<string, SelectiveCorpusVerifiedSpan[]>();
  const admittedByKey = new Map<string, CandidateAdmission>();
  for (const admission of admissions) {
    totals.textCompressedBytesRead += admission.textCompressedBytesRead;
    totals.textDecompressedBytes += admission.textDecompressedBytes;
    totals.textReadMs += admission.textReadMs;
    totals.textDecodeMs += admission.textDecodeMs;
    totals.verifyMs += admission.verifyMs;
    totals.sidecarReadMs += admission.sidecarReadMs ?? 0;
    totals.sidecarDecodeMs += admission.sidecarDecodeMs ?? 0;
    totals.sidecarBytesRead += admission.sidecarBytesRead ?? 0;
    if (admission.sourceFrom === "sidecar") totals.candidatesFromSidecar += 1;
    if (admission.familyGuardActivated) familyGuardActivations += 1;
  }
  const credited = (admission: CandidateAdmission) => admission.creditedSpans ?? admission.spans;
  const familyResolutions = resolveFamilyRepresentatives(
    admissions.filter((admission) => admission.outcome === "ADMITTED").map((admission) => ({ docId: admission.docId, creditedSpans: credited(admission) })),
    admissions.filter((admission) => admission.outcome === "FAMILY_MEMBER").map((admission) => ({ docId: admission.docId, creditedSpans: credited(admission) })),
  );
  const representatives = new Set(familyResolutions.filter((resolution) => resolution.role === "REPRESENTATIVE").map((resolution) => resolution.docId));
  for (const admission of admissions) {
    if (admission.outcome === "ADMITTED" || representatives.has(admission.docId)) {
      admittedSpans.set(admission.docId, credited(admission));
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
      familyRepresentative: representatives.has(docId),
      dominantSpanHolders: admission.dominantSpanHolders ?? null,
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
    candidatesVerified: admissions.filter((admission) => admission.outcome === "ADMITTED" || admission.outcome === "FAMILY_MEMBER" || admission.outcome === "NOT_ADMITTED").length,
    verifiedSources,
    matchedPositions: unified.matchedPositions,
    matchedWordCount: unified.uniqueMatchedWords,
    unifiedScore: unified.unifiedScore,
    coSourceActivations: coSource.activations,
    familyGuardActivations,
    familyPolicy: pass.familyPolicy ?? null,
    familyResolutions,
    failures: [...failures],
    verifierPath: pass.verifierPath ?? null,
    totals,
  };
}

/**
 * Candidates (in rank order) -> source text -> existing verifier -> existing
 * union and score. The submission is prepared once for the whole candidate
 * list unless `verifierPath: "oracle"` asks for the unmodified per-candidate
 * call.
 */
export async function verifyCandidatesWithExistingVerifier(
  reader: CorpusGenerationReader,
  submissionText: string,
  candidateDocIds: readonly bigint[],
  options: { verifierPath?: VerifierPath; familyPolicy?: FamilyAdmissionPolicyId; sidecars?: DerivedSourceSidecarSet | null } = {},
): Promise<CorpusVerificationResult> {
  const pass = await admitCandidates(reader, submissionText, candidateDocIds, undefined, options);
  return finalizeVerification(pass.identity, pass.submissionWordCount, pass.admissions, pass.failures, { verifierPath: pass.verifierPath, prepareMs: pass.prepareMs, familyPolicy: pass.familyPolicy });
}
