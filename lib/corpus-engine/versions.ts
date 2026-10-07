import { createHash } from "node:crypto";
import {
  ACTIVE_SCORING_NORMALIZATION_VERSION,
  gramHash,
  grams,
  tokensForScoringNormalization,
  type ScoringNormalizationVersion,
} from "../similarity-core";
import { winnow } from "../archive-fingerprint";
import {
  SELECTIVE_CORPUS_FINGERPRINT_VERSION,
  SELECTIVE_CORPUS_SHINGLE_SIZE,
  SELECTIVE_CORPUS_WINNOW_WINDOW,
} from "../selective-corpus/constants";

/**
 * Corpus Engine v1 — the versioned corpus contract.
 *
 * Every artifact a build writes and every request a query makes names the
 * versions below explicitly; nothing reads "latest". A generation manifest
 * stores the whole CorpusProcessingIdentity, and a reader refuses a generation
 * whose identity this build cannot reproduce (assertProcessingIdentitySupported).
 *
 * STATUS: FROZEN (2026-10-07, after the 100k checkpoint and the pre-1M
 * hardening). The core formats below — corpus layout and generation manifest,
 * index segment, postings codec, record pack, retrieval protocol and the
 * candidate-ranking algorithm — are frozen as v1. Their bytes and rules are
 * never edited in place: tests/corpus-engine-format-freeze.test.mjs pins the
 * bytes a fixed build produces, and any incompatible change is a new "-v2"
 * version string that readers of v1 refuse.
 *
 * NOT part of the frozen core, and versioned on their own:
 *   - the family admission policy (lib/corpus-engine/family-admission.ts),
 *     which is query-time and never changes stored bytes;
 *   - the derived-source sidecar (lib/corpus-engine/derived-source.ts), an
 *     optional, rebuildable artifact beside the segments;
 *   - the ranking policy's parameters (budget K, region width), which every
 *     request names; the measured default is K = 250.
 *
 * Generations built before the freeze record "candidate-unfrozen". The
 * status is not compared when a generation is opened (the formats did not
 * change), so they stay servable.
 */

export const CORPUS_FORMAT_STATUS = "frozen" as const;

/** The core formats CORPUS_FORMAT_STATUS covers. */
export const FROZEN_CORE_FORMATS = [
  "corpus-engine-format-v1",
  "index-segment-v1",
  "postings-delta-varint-v1",
  "record-pack-v1",
  /** The manifest shape (manifestKind "turnitplus-corpus-generation"), defined by corpus-engine-format-v1. */
  "generation-manifest-v1",
  "retrieval-protocol-v1",
  "candidate-ranking-v1",
] as const;

/**
 * The physical layout chosen for the 1M root: 16 document partitions
 * (~62.5k documents each at 1M, ~312.5k at 5M). partitionBits is fixed when a
 * root generation is built and inherited by every increment; the 100k root
 * keeps its 2 bits. One more bit later splits each partition in two without
 * moving any document of another partition (partition-docid-prefix-v1).
 */
export const CORPUS_1M_ROOT_PARTITION_BITS = 4;

/** Directory layout, generation manifest shape, segment/generation identity rules. */
export const CORPUS_FORMAT_VERSION = "corpus-engine-format-v1";
/** dict.bin / dict.idx / postings.bin / docs.bin byte layouts. */
export const INDEX_FORMAT_VERSION = "index-segment-v1";
/** Sorted segment-local ordinals, delta encoded, LEB128 varints. The only postings codec in v1. */
export const POSTINGS_CODEC_VERSION = "postings-delta-varint-v1";
/** Record packs: independently compressed chunks + fixed-width index rows. */
export const TEXT_PACK_FORMAT_VERSION = "record-pack-v1";
/** Two-phase lookup/score protocol and the COMPLETE / PARTIAL / FAILED contract. */
export const RETRIEVAL_PROTOCOL_VERSION = "retrieval-protocol-v1";
/** Rarity weights + per-region lists + depth-ordered fusion. */
export const CANDIDATE_RANKING_POLICY_VERSION = "candidate-ranking-v1";
/** 64-bit document id derivation and its representations. */
export const DOCUMENT_ID_CONTRACT_VERSION = "corpus-doc-id-v1";
/** Physical partition = the top partitionBits bits of the document id. */
export const PARTITION_CONTRACT_VERSION = "partition-docid-prefix-v1";
/** Exact normalized-content deduplication (sha256 of the normalized token stream). */
export const DEDUPLICATION_CONTRACT_VERSION = "dedup-exact-normalized-v1";
/** Served-generation-independent revocation list. */
export const REVOCATION_CONTRACT_VERSION = "revocation-v1";
/** Generation-level document-frequency artifact (df-high.bin + df-stats.json). */
export const DOCUMENT_FREQUENCY_CONTRACT_VERSION = "df-artifact-v1";
/** Durable build ledger record shapes. */
export const BUILD_LEDGER_VERSION = "build-ledger-v1";

/**
 * The normalization contract a corpus generation is built and queried under:
 * lib/similarity-core.ts's frozen scoring normalization (tokens = normalize of
 * the reference-stripped text). Pinned by number, never by "current".
 */
export const CORPUS_NORMALIZATION_CONTRACT_ID = "turnitplus-scoring-normalization";
export const CORPUS_NORMALIZATION_VERSION: ScoringNormalizationVersion = 2;

/**
 * The fingerprint contract: the EXISTING Selective Corpus Stage A
 * representation — winnowing (window 15) over the production 5-gram gramHash
 * stream — applied to documents and submissions alike. Nothing new is
 * introduced; tests/corpus-engine-fingerprint-contract.test.mjs proves the
 * hash sets are equal to lib/selective-corpus/fingerprint.ts's.
 */
export const CORPUS_FINGERPRINT_CONTRACT_ID = "corpus-engine-fp-v1";
export const CORPUS_FINGERPRINT_SHINGLE_SIZE = SELECTIVE_CORPUS_SHINGLE_SIZE;
export const CORPUS_FINGERPRINT_WINNOW_WINDOW = SELECTIVE_CORPUS_WINNOW_WINDOW;
export const CORPUS_FINGERPRINT_HASH = "gramHash:fnv1a32+djb2-32:uint64-be";

export type CorpusProcessingIdentity = {
  corpusFormat: string;
  formatStatus: string;
  indexFormat: string;
  postingsCodec: string;
  textPackFormat: string;
  retrievalProtocol: string;
  candidateRankingPolicy: string;
  documentIdContract: string;
  partitionContract: string;
  deduplicationContract: string;
  revocationContract: string;
  documentFrequencyContract: string;
  normalization: {
    contract: string;
    version: number;
    /** sha256 of what this build's normalizer makes of NORMALIZATION_PROBE_TEXT. */
    probeSha256: string;
  };
  fingerprint: {
    contract: string;
    shingleSize: number;
    winnowWindow: number;
    hash: string;
    /** The existing namespace this contract is byte-equal to. */
    equivalentTo: string;
    /** sha256 of the sorted fingerprints of FINGERPRINT_PROBE_TEXT. */
    probeSha256: string;
  };
};

/**
 * Behavioural probes. A version string says what a build CLAIMS to implement;
 * the probes record what it actually DID to a fixed input, so a silent change
 * to normalize(), to the reference-section strip or to the hash is caught when
 * a generation built before the change is opened after it.
 *
 * FROZEN TEXT — editing either probe invalidates every existing generation.
 * Code points are spelled as escapes so the source holds no invisible bytes.
 */
export const NORMALIZATION_PROBE_TEXT = [
  "Café naïve coöperate — ÉTÉ déjà; the ﬁrst ofﬁce, 3½ km² at 25℃.",
  "pla​giarism soft­hyphen zero‍width joined⁠words ﻿bom.",
  "الْعَرَبِيَّةُ لُغَةٌ جـــميلة ١٢٣ أإآا ىي ةه.",
  "ΣΟΦΟΣ σοφός STRASSE straße İstanbul ışık.",
  "Body paragraph one establishes the argument in ordinary prose so that the strip rule has real text to keep.",
  "Body paragraph two continues the argument and cites earlier work (Smith, 2019; Dupont et al., 2021) in line.",
  "",
  "References",
  "Smith, J. (2019). A study of things. Journal of Studies, 12(3), 45-67. https://doi.org/10.1000/xyz123",
  "Dupont, A., Martin, B., & Bernard, C. (2021). Une étude des choses. Revue des études, 8(1), 1-20.",
  "Al-Hassan, M. (2018). Dirasat fi al-ashya. Majallat al-Dirasat, 5(2), 100-120.",
  "Zhang, W. (2020). Further things considered. Annals of Things, 30(4), 400-420. https://doi.org/10.1000/abc",
  "Okafor, N. (2017). Things in context. Review of Context, 3(2), 11-29.",
  "Rossi, L. (2016). Cose e contesti. Rivista delle Cose, 9(1), 77-95.",
  "Kowalski, P. (2015). On the nature of things. Quarterly of Nature, 21(2), 201-230.",
  "Tanaka, H. (2014). Things and their measures. Measurement Letters, 2(4), 55-71.",
].join("\n");

export const FINGERPRINT_PROBE_TEXT = Array.from({ length: 240 }, (_, index) => {
  const value = (index * 2654435761) >>> 0;
  return `probe${(value % 9973).toString(36)}word${((value >>> 7) % 613).toString(36)}`;
}).join(" ");

const probeCache = new Map<string, string>();

export function normalizationProbeSha256(version: ScoringNormalizationVersion): string {
  const key = `n:${version}`;
  let digest = probeCache.get(key);
  if (digest === undefined) {
    digest = createHash("sha256")
      .update(tokensForScoringNormalization(NORMALIZATION_PROBE_TEXT, version).join(" "), "utf8")
      .digest("hex");
    probeCache.set(key, digest);
  }
  return digest;
}

export function fingerprintProbeSha256(version: ScoringNormalizationVersion): string {
  const key = `f:${version}`;
  let digest = probeCache.get(key);
  if (digest === undefined) {
    const words = tokensForScoringNormalization(FINGERPRINT_PROBE_TEXT, version);
    const sequence = grams(words, CORPUS_FINGERPRINT_SHINGLE_SIZE).map((gram) => gramHash(gram));
    const distinct = [...new Set(winnow(sequence, CORPUS_FINGERPRINT_WINNOW_WINDOW).map((selection) => selection.hash))].sort();
    digest = createHash("sha256").update(distinct.join("\n"), "utf8").digest("hex");
    probeCache.set(key, digest);
  }
  return digest;
}

/** The processing identity THIS build produces. Recorded in every generation it writes. */
export function currentProcessingIdentity(): CorpusProcessingIdentity {
  return {
    corpusFormat: CORPUS_FORMAT_VERSION,
    formatStatus: CORPUS_FORMAT_STATUS,
    indexFormat: INDEX_FORMAT_VERSION,
    postingsCodec: POSTINGS_CODEC_VERSION,
    textPackFormat: TEXT_PACK_FORMAT_VERSION,
    retrievalProtocol: RETRIEVAL_PROTOCOL_VERSION,
    candidateRankingPolicy: CANDIDATE_RANKING_POLICY_VERSION,
    documentIdContract: DOCUMENT_ID_CONTRACT_VERSION,
    partitionContract: PARTITION_CONTRACT_VERSION,
    deduplicationContract: DEDUPLICATION_CONTRACT_VERSION,
    revocationContract: REVOCATION_CONTRACT_VERSION,
    documentFrequencyContract: DOCUMENT_FREQUENCY_CONTRACT_VERSION,
    normalization: {
      contract: CORPUS_NORMALIZATION_CONTRACT_ID,
      version: CORPUS_NORMALIZATION_VERSION,
      probeSha256: normalizationProbeSha256(CORPUS_NORMALIZATION_VERSION),
    },
    fingerprint: {
      contract: CORPUS_FINGERPRINT_CONTRACT_ID,
      shingleSize: CORPUS_FINGERPRINT_SHINGLE_SIZE,
      winnowWindow: CORPUS_FINGERPRINT_WINNOW_WINDOW,
      hash: CORPUS_FINGERPRINT_HASH,
      equivalentTo: SELECTIVE_CORPUS_FINGERPRINT_VERSION,
      probeSha256: fingerprintProbeSha256(CORPUS_NORMALIZATION_VERSION),
    },
  };
}

/**
 * Why this build cannot serve a generation recorded with `identity` — empty
 * when it can. Compared field by field so the message names the field, and the
 * probes are recomputed under the running code rather than trusted.
 *
 * candidateRankingPolicy is NOT compared: ranking is a query-time policy that
 * every request names itself, so a generation built under an older default is
 * still servable.
 */
export function processingIdentityMismatches(identity: CorpusProcessingIdentity): string[] {
  const current = currentProcessingIdentity();
  const problems: string[] = [];
  const same = (label: string, recorded: unknown, expected: unknown) => {
    if (recorded !== expected) problems.push(`${label}: generation has ${JSON.stringify(recorded)}, this build supports ${JSON.stringify(expected)}`);
  };
  same("corpusFormat", identity?.corpusFormat, current.corpusFormat);
  same("indexFormat", identity?.indexFormat, current.indexFormat);
  same("postingsCodec", identity?.postingsCodec, current.postingsCodec);
  same("textPackFormat", identity?.textPackFormat, current.textPackFormat);
  same("retrievalProtocol", identity?.retrievalProtocol, current.retrievalProtocol);
  same("documentIdContract", identity?.documentIdContract, current.documentIdContract);
  same("partitionContract", identity?.partitionContract, current.partitionContract);
  same("deduplicationContract", identity?.deduplicationContract, current.deduplicationContract);
  same("revocationContract", identity?.revocationContract, current.revocationContract);
  same("documentFrequencyContract", identity?.documentFrequencyContract, current.documentFrequencyContract);
  same("normalization.contract", identity?.normalization?.contract, current.normalization.contract);
  same("normalization.version", identity?.normalization?.version, current.normalization.version);
  same("normalization.probeSha256", identity?.normalization?.probeSha256, current.normalization.probeSha256);
  same("fingerprint.contract", identity?.fingerprint?.contract, current.fingerprint.contract);
  same("fingerprint.shingleSize", identity?.fingerprint?.shingleSize, current.fingerprint.shingleSize);
  same("fingerprint.winnowWindow", identity?.fingerprint?.winnowWindow, current.fingerprint.winnowWindow);
  same("fingerprint.hash", identity?.fingerprint?.hash, current.fingerprint.hash);
  same("fingerprint.probeSha256", identity?.fingerprint?.probeSha256, current.fingerprint.probeSha256);
  return problems;
}

/**
 * The verifier downstream of retrieval tokenizes with the AMBIENT scoring
 * normalization (lib/similarity-core.ts tokens()). A generation may only be
 * verified against when that ambient contract is the one it was built under.
 */
export function ambientNormalizationMatches(identity: CorpusProcessingIdentity, ambientVersion: number): boolean {
  return identity.normalization.version === ambientVersion;
}

/** The scoring-normalization version new checks are computed under by this build. */
export const BUILD_ACTIVE_SCORING_NORMALIZATION_VERSION = ACTIVE_SCORING_NORMALIZATION_VERSION;
