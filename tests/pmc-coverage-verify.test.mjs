import assert from "node:assert/strict";
import test from "node:test";
import { tokens, grams, gramHash } from "../lib/similarity-core.ts";
import { scoreAgainstArchive } from "../lib/archive-similarity-scoring.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { verifyPmcCandidates } from "../lib/pmc-coverage/verify.ts";
import {
  computePmcCoverageCounterfactual,
  PmcCoverageCounterfactualInvariantError,
} from "../lib/pmc-coverage/counterfactual.ts";
import { PMC_MATCHING_PARAMETERS } from "../lib/pmc-coverage/constants.ts";
import { makeText, makeWords, spliceSubmission, NONINFORMATIVE_RUN, authoritativeFor } from "./helpers/pmc-coverage-shadow.mjs";

/**
 * Stage B — exact verification runs the UNMODIFIED lib/archive-similarity-scoring.ts
 * scoreAgainstArchive over the <= 20 candidates; the counterfactual runs the
 * UNMODIFIED lib/unified-similarity.ts computeUnifiedSimilarity.
 */

const cand = (pmcId, text) => ({ pmcId, doi: null, title: pmcId, canonicalText: text });

test("Stage B uses scoreAgainstArchive verbatim: same verified positions as a direct call", async () => {
  const sourceText = makeText("verify-source", 800);
  const words = sourceText.split(" ");
  const passage = words.slice(200, 250).join(" ");
  const submission = spliceSubmission({ hostSeed: "verify-host", hostWords: 500, passage });

  const candidates = [cand("PMC1", sourceText), cand("PMC2", makeText("verify-noise", 800))];

  // Direct scoreAgainstArchive over the same mini-index (no stop hashes).
  const hashSets = candidates.map((c) => new Set(grams(tokens(c.canonicalText), 5).map(gramHash)));
  const postings = new Map();
  hashSets.forEach((s, i) => {
    for (const h of s) {
      const list = postings.get(h);
      if (list) list.push(i);
      else postings.set(h, [i]);
    }
  });
  const direct = scoreAgainstArchive(submission, {
    shingleSize: 5,
    documentCount: candidates.length,
    maximumDocumentFrequency: PMC_MATCHING_PARAMETERS.maximumDocumentFrequency,
    articles: candidates.map((c, i) => ({ title: c.title, sourceType: "Publication", uniqueShingleCount: hashSets[i].size })),
    getPostings: (h) => postings.get(h) ?? [],
  }, PMC_MATCHING_PARAMETERS);

  const viaVerify = verifyPmcCandidates(submission, candidates, new Set());
  assert.deepEqual(viaVerify.verifiedPositions, direct.archiveMatchedPositions, "Stage B positions == direct scoreAgainstArchive positions");
  assert.ok(viaVerify.verifiedPositions.length >= 40, "the ~50-word copied passage is recovered");
  assert.ok(viaVerify.sources.some((s) => s.pmcId === "PMC1"), "PMC1 is the attributed source");
});

test("fingerprint-only hit cannot score: a non-informative shared run verifies to zero positions", () => {
  const submission = spliceSubmission({ hostSeed: "nf-verify-host", hostWords: 300, passage: NONINFORMATIVE_RUN });
  const candidateText = `${makeText("nf-cand-head", 200)} ${NONINFORMATIVE_RUN} ${makeText("nf-cand-tail", 200)}`;
  const result = verifyPmcCandidates(submission, [cand("PMCNF", candidateText)], new Set());
  assert.deepEqual(result.verifiedPositions, [], "informativeGram filter blocks every non-informative 5-gram");
  assert.deepEqual(result.sources, []);
});

test("fingerprint-only hit cannot score: an unrelated candidate verifies to zero positions", () => {
  const submission = makeText("unrelated-sub", 500);
  const result = verifyPmcCandidates(submission, [cand("PMCU", makeText("totally-different", 800))], new Set());
  assert.deepEqual(result.verifiedPositions, [], "no shared 5-gram => nothing verified");
});

test("Stage B: an empty candidate set is a clean zero", () => {
  const result = verifyPmcCandidates(makeText("x", 100), [], new Set());
  assert.deepEqual(result, { verifiedPositions: [], wordCount: 0, sources: [] });
});

test("counterfactual: verified ranges raise the unified score by exactly their marginal contribution", () => {
  const wordCount = 500;
  // authoritative: archive covered positions 0..49 (50 words) => score 10
  const archivePositions = Array.from({ length: 50 }, (_, i) => i);
  const authoritative = authoritativeFor({ wordCount, archiveMatchedPositions: archivePositions });
  assert.equal(authoritative.unifiedScore, 10);

  // PMC verified positions 100..199 (100 new words) => counterfactual union 150/500 => 30
  const pmcPositions = Array.from({ length: 100 }, (_, i) => 100 + i);
  const cf = computePmcCoverageCounterfactual({
    wordCount,
    authoritativeArchiveMatchedPositions: archivePositions,
    externalAcademicEvidence: null,
    historicalSubmissionMatch: null,
    effectiveDeviceSelfRepresentationIds: [],
    authoritativeUnifiedSimilarity: authoritative,
    pmcVerifiedPositions: pmcPositions,
  });
  assert.equal(cf.baselineScore, 10);
  assert.equal(cf.counterfactualScore, 30);
  assert.equal(cf.scoreDelta, 20);
  assert.equal(cf.pmcMatchedWordCount, 100);
  assert.equal(cf.pmcMarginalWordCount, 100);
});

test("counterfactual: PMC positions already covered by the authoritative union add nothing (no double count)", () => {
  const wordCount = 500;
  const archivePositions = Array.from({ length: 100 }, (_, i) => i);
  const authoritative = authoritativeFor({ wordCount, archiveMatchedPositions: archivePositions });
  const cf = computePmcCoverageCounterfactual({
    wordCount,
    authoritativeArchiveMatchedPositions: archivePositions,
    externalAcademicEvidence: null,
    historicalSubmissionMatch: null,
    effectiveDeviceSelfRepresentationIds: [],
    authoritativeUnifiedSimilarity: authoritative,
    pmcVerifiedPositions: Array.from({ length: 60 }, (_, i) => i + 20), // fully inside 0..99
  });
  assert.equal(cf.scoreDelta, 0);
  assert.equal(cf.pmcMatchedWordCount, 60);
  assert.equal(cf.pmcMarginalWordCount, 0);
  assert.equal(cf.counterfactualScore, cf.baselineScore);
});

test("counterfactual: a baseline parity mismatch throws BASELINE_MISMATCH (never publishes a misleading delta)", () => {
  const wordCount = 500;
  const authoritative = authoritativeFor({ wordCount, archiveMatchedPositions: [0, 1, 2, 3, 4] });
  // Hand it a DIFFERENT authoritative score than the inputs imply.
  const tampered = { ...authoritative, unifiedScore: 77 };
  assert.throws(
    () => computePmcCoverageCounterfactual({
      wordCount,
      authoritativeArchiveMatchedPositions: [0, 1, 2, 3, 4],
      externalAcademicEvidence: null,
      historicalSubmissionMatch: null,
      effectiveDeviceSelfRepresentationIds: [],
      authoritativeUnifiedSimilarity: tampered,
      pmcVerifiedPositions: [10, 11, 12, 13, 14],
    }),
    (err) => err instanceof PmcCoverageCounterfactualInvariantError && err.reason === "BASELINE_MISMATCH",
  );
});

test("counterfactual: computeUnifiedSimilarity is called unmodified — output identical to a manual union", () => {
  const wordCount = 400;
  const archivePositions = [0, 1, 2, 3, 4, 5];
  const authoritative = authoritativeFor({ wordCount, archiveMatchedPositions: archivePositions });
  const pmcPositions = [200, 201, 202, 203, 204];
  const cf = computePmcCoverageCounterfactual({
    wordCount,
    authoritativeArchiveMatchedPositions: archivePositions,
    externalAcademicEvidence: null,
    historicalSubmissionMatch: null,
    effectiveDeviceSelfRepresentationIds: [],
    authoritativeUnifiedSimilarity: authoritative,
    pmcVerifiedPositions: pmcPositions,
  });
  const manual = computeUnifiedSimilarity({ wordCount, archiveMatchedPositions: [...archivePositions, ...pmcPositions] });
  assert.equal(cf.counterfactualScore, manual.unifiedScore);
});
