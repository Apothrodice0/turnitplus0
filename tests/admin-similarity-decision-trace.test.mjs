import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import {
  buildAdminSimilarityDecisionTrace,
  ADMIN_SIMILARITY_DECISION_TRACE_SCHEMA_VERSION,
} from "../lib/admin-similarity-decision-trace.ts";

/**
 * Pure-builder coverage for lib/admin-similarity-decision-trace.ts. Every
 * fixture's unifiedSimilarity is produced by the REAL production
 * computeUnifiedSimilarity so the builder is always explaining a genuine,
 * internally-consistent result — never a hand-rolled one that could drift
 * from what the pipeline actually computes.
 *
 * Covers the admin-trace task's §14 (score invariance — the builder never
 * mutates its inputs and is deterministic), §15 A/B/C (0% / SELF-excluded /
 * 100%), §15 D (overlapping sources), §6 (word-union proof), §7 (0%
 * explanation), and §9 (Device Passport shadow projection, observation only).
 */

const repoRoot = path.resolve(".");

function range(start, endExclusive) {
  const out = [];
  for (let i = start; i < endExclusive; i += 1) out.push(i);
  return out;
}

function priorMatch({
  representationId,
  relationshipType = "PRIOR_SUBMISSION",
  matchType = "EXACT_CANONICAL_MATCH",
  matchedWordCount,
  submittedWordStart,
  submittedWordEnd,
  containment = 1,
  historicalSubmissionCount = 0,
}) {
  return {
    relationshipType,
    matchedRepresentationId: representationId,
    matchType,
    containment,
    matchedWordCount,
    passageCount: 1,
    longestMatchWords: matchedWordCount,
    passages: [{ submittedText: "x y z", submittedWordStart, submittedWordEnd, matchedWordCount }],
    historicalSubmissionCount,
  };
}

function historical(matches) {
  return {
    status: "MATCHED",
    matches,
    computedAt: new Date().toISOString(),
    matcherVersion: "test",
    fingerprintVersion: "test",
    canonicalizationVersion: "test",
  };
}

// ---------------------------------------------------------------------------
// A — 0 matched words -> 0%, NO_MATCHES_FOUND
// ---------------------------------------------------------------------------

test("A. no matched words -> finalScore 0, zeroScoreExplanation NO_MATCHES_FOUND, no sources", () => {
  const unified = computeUnifiedSimilarity({
    wordCount: 100,
    archiveMatchedPositions: [],
    externalAcademicEvidence: [],
    historicalSubmissionMatch: null,
  });
  const trace = buildAdminSimilarityDecisionTrace({ archiveScore: 0, unifiedSimilarity: unified, archiveMatchedPositions: [] });

  assert.equal(trace.schemaVersion, ADMIN_SIMILARITY_DECISION_TRACE_SCHEMA_VERSION);
  assert.equal(trace.resolvable, true);
  assert.equal(trace.finalScore, 0);
  assert.equal(trace.finalScore, unified.unifiedScore);
  assert.equal(trace.finalIncludedUnionWordCount, 0);
  assert.deepEqual(trace.sources, []);
  assert.ok(trace.zeroScoreExplanation);
  assert.equal(trace.zeroScoreExplanation.reason, "NO_MATCHES_FOUND");
  assert.equal(trace.zeroScoreExplanation.candidateRejectionDetailAvailable, false);
  assert.equal(trace.fullCoverageExplanation, null);
  assert.equal(trace.scoreUnchangedByDeviceShadow, true);
});

// ---------------------------------------------------------------------------
// B — historical EXACT match classified SELF only -> 0% contribution, EXCLUDED_SELF
// ---------------------------------------------------------------------------

test("B. an EXACT historical match classified SELF -> 0% score, source visible as EXCLUDED_SELF, not counted", () => {
  const match = historical([
    priorMatch({ representationId: "rep-self", relationshipType: "SELF", matchedWordCount: 100, submittedWordStart: 0, submittedWordEnd: 99 }),
  ]);
  const unified = computeUnifiedSimilarity({
    wordCount: 100,
    archiveMatchedPositions: [],
    externalAcademicEvidence: [],
    historicalSubmissionMatch: match,
  });
  assert.equal(unified.unifiedScore, 0, "sanity: SELF contributes nothing");
  assert.equal(unified.selfExcludedWords, 100);

  const trace = buildAdminSimilarityDecisionTrace({
    archiveScore: 0,
    unifiedSimilarity: unified,
    archiveMatchedPositions: [],
    historicalSubmissionMatch: match,
  });

  assert.equal(trace.finalScore, 0);
  assert.equal(trace.excludedSelfMatchedWordCount, 100);
  assert.equal(trace.sources.length, 1);
  const [self] = trace.sources;
  assert.equal(self.relationshipType, "SELF");
  assert.equal(self.countedTowardScore, false);
  assert.equal(self.exclusionReason, "EXCLUDED_SELF");
  assert.equal(self.rawMatchedWordCount, 100, "the excluded footprint is still shown");
  assert.equal(self.countedWordCount, 0);
  assert.equal(self.newUniqueWordContribution, 0);
  assert.equal(self.matchType, "EXACT_CANONICAL_MATCH");
  assert.equal(trace.zeroScoreExplanation.reason, "MATCHES_PRESENT_BUT_ALL_EXCLUDED");
  assert.equal(trace.zeroScoreExplanation.excludedSelfSourceCount, 1);
});

test("B2. an UNKNOWN_RELATIONSHIP match -> EXCLUDED_UNKNOWN_RELATIONSHIP, not counted", () => {
  const match = historical([
    priorMatch({ representationId: "rep-unk", relationshipType: "UNKNOWN_RELATIONSHIP", matchType: "STRONG_TEXT_MATCH", matchedWordCount: 50, submittedWordStart: 0, submittedWordEnd: 49 }),
  ]);
  const unified = computeUnifiedSimilarity({ wordCount: 200, archiveMatchedPositions: [], externalAcademicEvidence: [], historicalSubmissionMatch: match });
  const trace = buildAdminSimilarityDecisionTrace({ archiveScore: 0, unifiedSimilarity: unified, archiveMatchedPositions: [], historicalSubmissionMatch: match });
  assert.equal(trace.sources.length, 1);
  assert.equal(trace.sources[0].exclusionReason, "EXCLUDED_UNKNOWN_RELATIONSHIP");
  assert.equal(trace.sources[0].countedTowardScore, false);
  assert.equal(trace.excludedUnknownMatchedWordCount, 50);
});

// ---------------------------------------------------------------------------
// C — exact counted source covering the whole document -> 100%
// ---------------------------------------------------------------------------

test("C. an EXACT PRIOR_SUBMISSION covering every word -> finalScore 100, fullCoverageExplanation, union == submitted", () => {
  const match = historical([
    priorMatch({ representationId: "rep-prior", relationshipType: "PRIOR_SUBMISSION", matchedWordCount: 120, submittedWordStart: 0, submittedWordEnd: 119 }),
  ]);
  const unified = computeUnifiedSimilarity({ wordCount: 120, archiveMatchedPositions: [], externalAcademicEvidence: [], historicalSubmissionMatch: match });
  assert.equal(unified.unifiedScore, 100);

  const trace = buildAdminSimilarityDecisionTrace({ archiveScore: 0, unifiedSimilarity: unified, archiveMatchedPositions: [], historicalSubmissionMatch: match });

  assert.equal(trace.finalScore, 100);
  assert.equal(trace.finalIncludedUnionWordCount, 120);
  assert.equal(trace.finalIncludedUnionWordCount, unified.uniqueMatchedWords);
  assert.equal(trace.finalIncludedUnionWordCount, unified.matchedPositions.length);
  assert.ok(trace.fullCoverageExplanation);
  assert.equal(trace.fullCoverageExplanation.includedUnionWordCount, 120);
  assert.equal(trace.fullCoverageExplanation.submittedWordCount, 120);
  assert.deepEqual(trace.fullCoverageExplanation.drivingSources, ["prior:0"]);
  assert.equal(trace.zeroScoreExplanation, null);

  const [prior] = trace.sources;
  assert.equal(prior.countedTowardScore, true);
  assert.equal(prior.countedReason, "COUNTED_PRIOR_SUBMISSION");
  assert.equal(prior.newUniqueWordContribution, 120);
  assert.equal(prior.overlappingWordCount, 0);
});

test("C2. an EXACT TURNITPLUS_CORPUS_SOURCE covering every word -> COUNTED_CORPUS_SOURCE", () => {
  const match = historical([
    priorMatch({ representationId: "rep-corpus", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchedWordCount: 80, submittedWordStart: 0, submittedWordEnd: 79 }),
  ]);
  const unified = computeUnifiedSimilarity({ wordCount: 80, archiveMatchedPositions: [], externalAcademicEvidence: [], historicalSubmissionMatch: match });
  const trace = buildAdminSimilarityDecisionTrace({ archiveScore: 0, unifiedSimilarity: unified, archiveMatchedPositions: [], historicalSubmissionMatch: match });
  assert.equal(trace.sources[0].countedReason, "COUNTED_CORPUS_SOURCE");
  assert.equal(trace.finalScore, 100);
});

// ---------------------------------------------------------------------------
// D — two overlapping sources -> union, not sum; unique contribution visible
// ---------------------------------------------------------------------------

test("D. archive raw 70 + prior raw 60 with 30 overlap -> union 100 (not 130), per-source unique contribution visible", () => {
  const archiveMatchedPositions = range(0, 70); // words 0..69
  const match = historical([
    priorMatch({
      representationId: "rep-b",
      relationshipType: "PRIOR_SUBMISSION",
      matchType: "STRONG_TEXT_MATCH",
      containment: 0.6,
      matchedWordCount: 60,
      submittedWordStart: 40,
      submittedWordEnd: 99, // words 40..99
    }),
  ]);
  const unified = computeUnifiedSimilarity({ wordCount: 130, archiveMatchedPositions, externalAcademicEvidence: [], historicalSubmissionMatch: match });

  // sanity on the production result itself
  assert.equal(unified.uniqueMatchedWords, 100, "union is 100 distinct positions, never 70+60");
  assert.equal(unified.overlapWords, 30);
  assert.equal(unified.archiveOnlyWords, 40);
  assert.equal(unified.previousUploadOnlyWords, 30);

  const trace = buildAdminSimilarityDecisionTrace({ archiveScore: 54, unifiedSimilarity: unified, archiveMatchedPositions, historicalSubmissionMatch: match });

  assert.equal(trace.finalIncludedUnionWordCount, 100);
  assert.equal(trace.finalScore, unified.unifiedScore); // round(100/130*100) = 77
  assert.equal(trace.multiSourceOverlapWordCount, 30);
  assert.deepEqual(trace.unionAccumulationOrder, ["archive", "prior:0"]);

  const archive = trace.sources.find((s) => s.sourceKey === "archive");
  const prior = trace.sources.find((s) => s.sourceKey === "prior:0");
  assert.equal(archive.rawMatchedWordCount, 70);
  assert.equal(archive.newUniqueWordContribution, 70);
  assert.equal(archive.overlappingWordCount, 0);
  assert.equal(prior.rawMatchedWordCount, 60);
  assert.equal(prior.countedWordCount, 60);
  assert.equal(prior.newUniqueWordContribution, 30, "the 30 words already matched by the archive are not double-counted");
  assert.equal(prior.overlappingWordCount, 30);

  // §6 word-union proof: sum of per-source unique contributions == the union
  const sumUnique = trace.sources.reduce((total, s) => total + s.newUniqueWordContribution, 0);
  assert.equal(sumUnique, trace.finalIncludedUnionWordCount);
  assert.equal(trace.unattributedUnionWordCount, 0);
});

test("D2. a fully-overlapped counted source -> countedTowardScore true, newUnique 0, ALL_POSITIONS_ALREADY_COUNTED", () => {
  const archiveMatchedPositions = range(0, 100);
  const match = historical([
    priorMatch({ representationId: "rep-dup", relationshipType: "PRIOR_SUBMISSION", matchedWordCount: 40, submittedWordStart: 10, submittedWordEnd: 49 }),
  ]);
  const unified = computeUnifiedSimilarity({ wordCount: 100, archiveMatchedPositions, externalAcademicEvidence: [], historicalSubmissionMatch: match });
  const trace = buildAdminSimilarityDecisionTrace({ archiveScore: 100, unifiedSimilarity: unified, archiveMatchedPositions, historicalSubmissionMatch: match });
  const prior = trace.sources.find((s) => s.sourceKey === "prior:0");
  assert.equal(prior.countedTowardScore, true);
  assert.equal(prior.rawMatchedWordCount, 40);
  assert.equal(prior.newUniqueWordContribution, 0);
  assert.equal(prior.contributionNote, "ALL_POSITIONS_ALREADY_COUNTED");
});

// ---------------------------------------------------------------------------
// account / device evidence pass-through (resolution happens in the admin repo)
// ---------------------------------------------------------------------------

test("E. account + device evidence supplied by the caller is attached to the matching source verbatim", () => {
  const match = historical([
    priorMatch({ representationId: "rep-e", relationshipType: "PRIOR_SUBMISSION", matchedWordCount: 50, submittedWordStart: 0, submittedWordEnd: 49 }),
  ]);
  const unified = computeUnifiedSimilarity({ wordCount: 100, archiveMatchedPositions: [], externalAcademicEvidence: [], historicalSubmissionMatch: match });
  const accountEvidence = {
    hasSameAccountSubmission: false,
    otherAccountSubmissionCount: 2,
    sameAccountBackingCount: 0,
    otherAccountBackingCount: 2,
    anonymousBackingCount: 0,
    backings: [{ channel: "SUBMISSION_REFERENCE", relationshipToReportAccount: "OTHER_ACCOUNT", accountEmail: "other@example.com", accountUsername: "other", documentIdentityId: "di-1", admissionDecisionId: null, sourceReportId: null }],
    backingListTruncated: false,
  };
  const deviceEvidence = {
    sameVerifiedDeviceBacking: false,
    sameDeviceBackingCount: 0,
    independentBackingCount: 2,
    backingsWithoutDeviceProvenance: 2,
    admittedBackingsDifferentDevice: 0,
    admittedBackingsNoDeviceProvenance: 0,
    admittedPromotionBackingCount: 0,
    submissionReferenceBackingCount: 2,
    identitySameAccount: false,
    priorSameAccountIdentityCount: 0,
  };
  const trace = buildAdminSimilarityDecisionTrace({
    archiveScore: 0,
    unifiedSimilarity: unified,
    historicalSubmissionMatch: match,
    accountEvidenceByRepresentation: { "rep-e": accountEvidence },
    deviceEvidenceByRepresentation: { "rep-e": deviceEvidence },
  });
  const [prior] = trace.sources;
  assert.deepEqual(prior.accountEvidence, accountEvidence);
  assert.deepEqual(prior.deviceEvidence, deviceEvidence);
});

// ---------------------------------------------------------------------------
// G — Device Passport shadow projection (observation only)
// ---------------------------------------------------------------------------

test("G. a device-provenance shadow row that would downgrade -> SELF proposal, SAME_DEVICE_EXACT_DOCUMENT, score unchanged", () => {
  const match = historical([
    priorMatch({ representationId: "rep-g", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchedWordCount: 90, submittedWordStart: 0, submittedWordEnd: 89 }),
  ]);
  const unified = computeUnifiedSimilarity({ wordCount: 90, archiveMatchedPositions: [], externalAcademicEvidence: [], historicalSubmissionMatch: match });
  const trace = buildAdminSimilarityDecisionTrace({
    archiveScore: 0,
    unifiedSimilarity: unified,
    historicalSubmissionMatch: match,
    hasVerifiedUploadPassport: true,
    deviceShadow: {
      policyVersion: "device-provenance-shadow-v1",
      computedAt: "2026-08-28T00:00:00Z",
      status: "OK",
      productionStatus: "MATCHED",
      productionRelationship: "TURNITPLUS_CORPUS_SOURCE",
      proposedRelationship: "SELF",
      agreement: "DISAGREE_DEVICE_SELF",
      evidence: {
        reason: "SAME_DEVICE_EXACT_DOCUMENT",
        hasReportPassport: true,
        wouldDowngrade: true,
        deviceSelfCandidateCount: 1,
        exactSameDeviceMatchCount: 1,
        independentBlockedCandidateCount: 0,
        matchesEvaluated: 1,
        candidateReason: "SAME_DEVICE_EXACT_DOCUMENT",
        deviceDistinctAccounts: 1,
        deviceSubmissionCount: 1,
        deviceAnonUploads: 0,
        deviceSharedAcrossAccounts: false,
      },
    },
  });

  assert.equal(trace.finalScore, 100, "production score is what production computed");
  assert.equal(trace.scoreUnchangedByDeviceShadow, true);
  assert.ok(trace.deviceShadow);
  assert.equal(trace.deviceShadow.verifiedUploadPassport, true);
  assert.equal(trace.deviceShadow.wouldDowngrade, true);
  assert.equal(trace.deviceShadow.shadowProposal, "SELF");
  assert.equal(trace.deviceShadow.reason, "SAME_DEVICE_EXACT_DOCUMENT");
  assert.equal(trace.deviceShadow.candidateReason, "SAME_DEVICE_EXACT_DOCUMENT");
  assert.equal(trace.deviceShadow.deviceSelfCandidateCount, 1);
  assert.equal(trace.deviceShadow.productionScoreChangedByShadow, false);
});

test("G2. no shadow row -> trace.deviceShadow is null, no crash", () => {
  const unified = computeUnifiedSimilarity({ wordCount: 10, archiveMatchedPositions: [], externalAcademicEvidence: [], historicalSubmissionMatch: null });
  const trace = buildAdminSimilarityDecisionTrace({ archiveScore: 0, unifiedSimilarity: unified });
  assert.equal(trace.deviceShadow, null);
  assert.equal(trace.scoreUnchangedByDeviceShadow, true);
});

// ---------------------------------------------------------------------------
// §14 — score invariance: the builder never mutates its inputs, deterministic
// ---------------------------------------------------------------------------

test("§14. building the trace never mutates unifiedSimilarity / historicalSubmissionMatch and is deterministic", () => {
  const match = historical([
    priorMatch({ representationId: "rep-a", relationshipType: "PRIOR_SUBMISSION", matchedWordCount: 60, submittedWordStart: 0, submittedWordEnd: 59 }),
    priorMatch({ representationId: "rep-b", relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "STRONG_TEXT_MATCH", containment: 0.5, matchedWordCount: 40, submittedWordStart: 50, submittedWordEnd: 89 }),
  ]);
  const archiveMatchedPositions = range(0, 30);
  const unified = computeUnifiedSimilarity({ wordCount: 120, archiveMatchedPositions, externalAcademicEvidence: [], historicalSubmissionMatch: match });

  const unifiedClone = JSON.parse(JSON.stringify(unified));
  const matchClone = JSON.parse(JSON.stringify(match));
  const archiveClone = [...archiveMatchedPositions];

  const first = buildAdminSimilarityDecisionTrace({ archiveScore: 25, unifiedSimilarity: unified, archiveMatchedPositions, historicalSubmissionMatch: match });
  const second = buildAdminSimilarityDecisionTrace({ archiveScore: 25, unifiedSimilarity: unified, archiveMatchedPositions, historicalSubmissionMatch: match });

  assert.deepEqual(unified, unifiedClone, "unifiedSimilarity must be untouched");
  assert.deepEqual(match, matchClone, "historicalSubmissionMatch must be untouched");
  assert.deepEqual(archiveMatchedPositions, archiveClone, "archiveMatchedPositions must be untouched");
  assert.deepEqual(first, second, "the builder must be deterministic");

  // the explained score equals what computeUnifiedSimilarity itself produced
  assert.equal(first.finalScore, unified.unifiedScore);
  assert.equal(first.finalIncludedUnionWordCount, unified.matchedPositions.length);
  const sumUnique = first.sources.reduce((total, s) => total + s.newUniqueWordContribution, 0);
  assert.equal(sumUnique, first.finalIncludedUnionWordCount);
});

// ---------------------------------------------------------------------------
// unresolvable / legacy report
// ---------------------------------------------------------------------------

test("legacy report with no unifiedSimilarity -> resolvable false, archive-only fallback, no crash", () => {
  const trace = buildAdminSimilarityDecisionTrace({ archiveScore: 42, unifiedSimilarity: null });
  assert.equal(trace.resolvable, false);
  assert.equal(trace.unresolvableReason, "UNIFIED_SIMILARITY_NOT_PERSISTED");
  assert.equal(trace.finalScore, 42);
  assert.equal(trace.finalScoreBasis, "ARCHIVE_ONLY_FALLBACK");
  assert.deepEqual(trace.sources, []);
});

// ---------------------------------------------------------------------------
// §13 privacy — the builder module names no device-passport secret field
// ---------------------------------------------------------------------------

test("§13 structural: the builder source never references a passport id / key / signature / challenge / nonce / session field", () => {
  const src = fs.readFileSync(path.join(repoRoot, "lib/admin-similarity-decision-trace.ts"), "utf8");
  for (const forbidden of [
    /publicKey/i,
    /publicKeySpki/,
    /spki/i,
    /\.signature\b/,
    /signatureBase64/i,
    /challengeId/i,
    /nonceBase64/i,
    /sessionToken/i,
    /passportId/i,
    /verified_device_passport_id/,
  ]) {
    assert.doesNotMatch(src, forbidden, `admin-similarity-decision-trace.ts must not reference ${forbidden}`);
  }
});

console.log("admin-similarity-decision-trace: pure-builder scenarios A/B/C/D/E/G + §14 invariance + privacy passed");
