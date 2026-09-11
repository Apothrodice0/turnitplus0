import { tokens } from "../../lib/similarity-core";
import { compareSubmissionToExternalText } from "../../lib/academic-search/comparator";
import { winnowWordSpanHashes } from "../../lib/selective-corpus/fingerprint";
import { InMemoryPostingsAccessor } from "../../lib/selective-corpus/shard-reader";
import {
  SELECTIVE_CORPUS_VERSION,
  SELECTIVE_CORPUS_EXPECTED_DIGEST,
  SELECTIVE_CORPUS_FINGERPRINT_VERSION,
} from "../../lib/selective-corpus/constants";
import type { SelectiveCorpusArtifact } from "../../lib/selective-corpus/artifact";
import type { AcademicSearchCaseInput } from "./academic-search-lane";
import type { SelectiveCorpusCaseInput } from "./selective-corpus-lane";
import type { SourceCoverageCaseInput } from "./classify";

/**
 * Deterministic LOCAL/SYNTHETIC fixtures only.
 *
 * Not any real, closed, sealed, or not-yet-available manuscript/source
 * dataset this project tracks (see tests/source-coverage-classifier.test.mjs's
 * structural-safety tests, which grep this directory for those datasets'
 * own names to prove it). Every manuscript/candidate text below is
 * generated in-memory by synthText(); nothing is read from disk.
 */

// ---- synthetic vocabulary -------------------------------------------------

/** Every word is >=4 chars, alphanumeric, and never in lib/similarity-core.ts's COMMON_WORDS or GENERIC_ACADEMIC_REGISTER_WORDS, so shingle matching behaves predictably and every matched word is attributable to a deliberate overlap, never an accidental common-word collision. */
function synthWord(index: number): string {
  return `synthterm${String(index).padStart(5, "0")}`;
}
export function synthText(startIndex: number, count: number): string {
  return Array.from({ length: count }, (_, k) => synthWord(startIndex + k)).join(" ");
}

/** A 200-distinct-word synthetic manuscript shared by every fixture case below. */
export const SUBMISSION_TEXT = synthText(0, 200);

// ---- Selective Corpus in-memory fixture artifacts -------------------------

/** An artifact with empty postings/stopHashes — FAMILY_GUARD can never activate against it (no doc ever recurs >= 3 times), so any admitted match is admitted cleanly. */
export function buildEmptyFixtureArtifact(documentCount = 1): SelectiveCorpusArtifact {
  return {
    artifactPath: "in-memory-fixture",
    corpusVersion: SELECTIVE_CORPUS_VERSION,
    corpusDigest: SELECTIVE_CORPUS_EXPECTED_DIGEST,
    fingerprintVersion: SELECTIVE_CORPUS_FINGERPRINT_VERSION,
    documentCount,
    postingsAccessor: new InMemoryPostingsAccessor(new Map()),
    stopHashes: new Set(),
    docs: [],
    docByOrdinal: [],
    mode: "in-memory",
  };
}

/** Finds the dominant (longest) matched passage the REAL, unmodified comparator produces for `candidateText` against `submissionText` — used by both FAMILY_GUARD fixture builders below so each seeds its artifact from the exact span verify.ts will itself compute, never a hand-guessed one. */
function dominantMatchedSpan(submissionText: string, candidateText: string) {
  const comparison = compareSubmissionToExternalText(submissionText, candidateText);
  const dominant = [...comparison.matchedPassages].sort((a, b) => b.matchedWordCount - a.matchedWordCount)[0];
  if (!dominant) {
    throw new Error("dominantMatchedSpan: fixture texts produced no matched passage to make boilerplate");
  }
  return tokens(submissionText).slice(dominant.submittedWordStart, dominant.submittedWordEnd + 1);
}

/**
 * FAMILY_GUARD path 1: lib/selective-corpus/verify.ts's classifySpanFamily
 * stopFraction branch (`stopHits/n >= SELECTIVE_CORPUS_FAMILY_GUARD.stopFractionBoilerplate`).
 * Seeds the artifact's stopHashes with the dominant span's own winnowed
 * hashes, exercising the SAME real function real production would run
 * against a globally-high-document-frequency span — no real corpus, no
 * disk, no network.
 */
export function buildBoilerplateFamilyFixtureArtifact(submissionText: string, candidateText: string): SelectiveCorpusArtifact {
  const words = dominantMatchedSpan(submissionText, candidateText);
  const stopHashes = new Set(winnowWordSpanHashes(words));
  return { ...buildEmptyFixtureArtifact(), stopHashes };
}

/**
 * FAMILY_GUARD path 2: classifySpanFamily's OTHER real trigger —
 * postings-based `distinctDocs >= SELECTIVE_CORPUS_FAMILY_GUARD.dominantSpanFamilyDocThreshold`
 * (stopHashes stays empty, so the stopFraction branch never fires). Every
 * winnowed hash of the dominant span is seeded to recur across 3 synthetic
 * doc ordinals in a local, in-memory postings map — never a real corpus, no
 * disk, no network — which is exactly the "recurs across >= 3 indexed
 * documents" condition classifySpanFamily checks for real.
 */
export function buildPostingsFamilyFixtureArtifact(submissionText: string, candidateText: string): SelectiveCorpusArtifact {
  const words = dominantMatchedSpan(submissionText, candidateText);
  const hashes = winnowWordSpanHashes(words);
  const postings = new Map<string, Uint32Array>();
  for (const hash of hashes) postings.set(hash, new Uint32Array([0, 1, 2]));
  return { ...buildEmptyFixtureArtifact(3), postingsAccessor: new InMemoryPostingsAccessor(postings) };
}

// ---- ACADEMIC_SEARCH lane fixture cases ------------------------------------

const AS_RECOVERED_TEXT = synthText(0, 90); // verbatim 90-word prefix of the manuscript
const AS_MATCHER_FAILED_TEXT = synthText(9000, 30); // disjoint vocabulary window -> zero overlap
const AS_LANE_ISOLATION_TEXT = synthText(0, 40); // verbatim 40-word prefix: clears academic-search's 15% bar but would fail Selective Corpus's 60-word STRICT_SPAN

export const ACADEMIC_SEARCH_FIXTURE_CASES: AcademicSearchCaseInput[] = [
  {
    caseId: "as-01-source-absent",
    expectedSourceId: "expected-src-absent",
    submittedText: SUBMISSION_TEXT,
    groundTruthAbsent: {
      reasonCode: "CONFIRMED_NOT_INDEXED",
      detail: "Fixture ground truth: hand-confirmed this work is not indexed by any configured academic-search provider.",
    },
    discovery: { status: "NOT_DISCOVERED" },
  },
  {
    caseId: "as-02-candidate-missed",
    expectedSourceId: "expected-src-missed",
    submittedText: SUBMISSION_TEXT,
    discovery: { status: "NOT_DISCOVERED" },
  },
  {
    caseId: "as-02b-ranked-outside-retrieval-budget",
    expectedSourceId: "expected-src-outside-budget",
    submittedText: SUBMISSION_TEXT,
    discovery: { status: "RANKED_OUTSIDE_RETRIEVAL_BUDGET", candidateRank: 7 },
  },
  {
    caseId: "as-03-retrieval-failed",
    expectedSourceId: "expected-src-retrieval",
    submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "unavailable", httpRetrievalStatus: "NETWORK_ERROR" },
  },
  {
    caseId: "as-03b-retrieval-failed-no-http-status",
    expectedSourceId: "expected-src-retrieval-no-url",
    submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "unavailable" }, // no candidate URL at all -> HTTP fallback never attempted, no httpRetrievalStatus
  },
  {
    caseId: "as-04-extraction-failed",
    expectedSourceId: "expected-src-extraction",
    submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    // Production-shaped: content WAS fetched, but lib/http-content-retriever.ts's
    // own extraction step found no usable text — RetrievalStatus.EXTRACTION_FAILED,
    // a sub-case of source:"unavailable", never a stage reached after success.
    retrieval: { source: "unavailable", httpRetrievalStatus: "EXTRACTION_FAILED" },
  },
  {
    caseId: "as-05-matcher-failed",
    expectedSourceId: "expected-src-nomatch",
    submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "provider", retrievedTextLength: AS_MATCHER_FAILED_TEXT.length },
    retrievedExternalText: AS_MATCHER_FAILED_TEXT,
  },
  {
    caseId: "as-06-verified-recovered",
    expectedSourceId: "expected-src-recovered",
    submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "provider", retrievedTextLength: AS_RECOVERED_TEXT.length },
    retrievedExternalText: AS_RECOVERED_TEXT,
  },
  {
    caseId: "as-09-no-candidate-not-absent",
    expectedSourceId: "expected-src-no-proof",
    submittedText: SUBMISSION_TEXT,
    discovery: { status: "NOT_DISCOVERED" }, // deliberately no groundTruthAbsent supplied
  },
  {
    caseId: "as-12-lane-isolation-40-words",
    expectedSourceId: "expected-src-40words",
    submittedText: SUBMISSION_TEXT,
    discovery: { status: "SELECTED_FOR_RETRIEVAL", candidateRank: 0 },
    retrieval: { source: "provider", retrievedTextLength: AS_LANE_ISOLATION_TEXT.length },
    retrievedExternalText: AS_LANE_ISOLATION_TEXT,
  },
];

// ---- SELECTIVE_CORPUS lane fixture cases -----------------------------------

const SC_RECOVERED_TEXT = synthText(0, 90); // verbatim 90-word prefix: passes STRICT_SPAN, no boilerplate seeded
const SC_MATCHER_FAILED_TEXT = synthText(0, 40); // verbatim 40-word prefix: matched words ~40 < 60 -> fails STRICT_SPAN
const SC_FAMILY_GUARD_TEXT = synthText(0, 90); // same shape as recovered, evaluated against a boilerplate-seeded artifact
const SC_LANE_ISOLATION_TEXT = synthText(0, 40); // identical text to as-12, evaluated under Selective Corpus's own (different) gate

export const SELECTIVE_CORPUS_FIXTURE_CASES: SelectiveCorpusCaseInput[] = [
  {
    caseId: "sc-01-source-absent",
    expectedSourceId: "sc-expected-absent",
    submissionText: SUBMISSION_TEXT,
    groundTruthAbsent: {
      reasonCode: "CONFIRMED_NOT_IN_ARTIFACT",
      detail: "Fixture ground truth: hand-confirmed this source document is not part of the evaluated Selective Corpus artifact.",
    },
    stageA: { surfaced: false, candidateRank: null },
  },
  {
    caseId: "sc-02-candidate-missed",
    expectedSourceId: "sc-expected-missed",
    submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: false, candidateRank: null },
  },
  {
    caseId: "sc-03-retrieval-failed",
    expectedSourceId: "sc-expected-retrieval",
    submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: true, candidateRank: 0 },
    sourceText: { available: false },
  },
  {
    caseId: "sc-05-matcher-failed",
    expectedSourceId: "sc-expected-nomatch",
    submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: true, candidateRank: 0 },
    sourceText: { available: true, text: SC_MATCHER_FAILED_TEXT },
    artifact: buildEmptyFixtureArtifact(),
  },
  {
    caseId: "sc-06-admission-attribution-failed-stopfraction-path",
    expectedSourceId: "sc-expected-familyguard-stopfraction",
    submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: true, candidateRank: 0 },
    sourceText: { available: true, text: SC_FAMILY_GUARD_TEXT },
    artifact: buildBoilerplateFamilyFixtureArtifact(SUBMISSION_TEXT, SC_FAMILY_GUARD_TEXT),
  },
  {
    caseId: "sc-06b-admission-attribution-failed-postings-path",
    expectedSourceId: "sc-expected-familyguard-postings",
    submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: true, candidateRank: 0 },
    sourceText: { available: true, text: SC_FAMILY_GUARD_TEXT },
    artifact: buildPostingsFamilyFixtureArtifact(SUBMISSION_TEXT, SC_FAMILY_GUARD_TEXT),
  },
  {
    caseId: "sc-08-verified-recovered",
    expectedSourceId: "sc-expected-recovered",
    submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: true, candidateRank: 0 },
    sourceText: { available: true, text: SC_RECOVERED_TEXT },
    artifact: buildEmptyFixtureArtifact(),
  },
  {
    caseId: "sc-09-no-candidate-not-absent",
    expectedSourceId: "sc-expected-no-proof",
    submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: false, candidateRank: null }, // deliberately no groundTruthAbsent supplied
  },
  {
    caseId: "sc-13-lane-isolation-40-words",
    expectedSourceId: "sc-expected-40words",
    submissionText: SUBMISSION_TEXT,
    stageA: { surfaced: true, candidateRank: 0 },
    sourceText: { available: true, text: SC_LANE_ISOLATION_TEXT },
    artifact: buildEmptyFixtureArtifact(),
  },
];

export const ALL_FIXTURE_CASES: SourceCoverageCaseInput[] = [
  ...ACADEMIC_SEARCH_FIXTURE_CASES.map((c) => ({ lane: "ACADEMIC_SEARCH" as const, ...c })),
  ...SELECTIVE_CORPUS_FIXTURE_CASES.map((c) => ({ lane: "SELECTIVE_CORPUS" as const, ...c })),
];
