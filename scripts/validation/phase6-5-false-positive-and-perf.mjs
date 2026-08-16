// Phase 6.5 false-positive safety controls + performance measurements — NOT
// part of the shipped app, NOT a committed test file. Real archive matcher
// (real 230-doc index) + real live search calls against genuinely
// constructed control text.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getExternalAcademicEvidence } from "../../lib/academic-evidence-integration.ts";
import { computeUnifiedSimilarity } from "../../lib/unified-similarity.ts";
import { realArchiveAnalyze } from "./real-archive-analyze.mjs";
import { REFERENCE_TEXT, KERNZA_ABSTRACT } from "./fixtures.mjs";

const results = { falsePositiveControls: [], performance: {} };

function record(label, entry) {
  results.falsePositiveControls.push({ label, ...entry });
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(entry, null, 2));
}

// --- Control 1: topical similarity (same subject, entirely different wording) ---
const TOPICAL_PARAPHRASE = `Deep-sea vent ecosystems recovering from a volcanic event offer scientists an unusual chance to watch chemosynthetic communities rebuild essentially from scratch. A multi-year survey program revisited several vent sites after an eruption and tracked how bacterial mats, tubeworm colonies, and the small grazing animals living among them changed over time. Early on, sulfur-processing bacteria dominated the newly exposed rock, but as tubeworm colonies grew larger and denser, the bacterial mats receded, apparently because the tubeworms themselves altered the local chemistry and available surface area. Snails and small crustaceans became more abundant as the tubeworm bushes grew more structurally complex, tracking habitat complexity rather than simply the passage of time since the eruption. Genetic testing of the tubeworms found little difference between colonies at different vent sites along the ridge, implying that larvae can travel and interbreed across considerable distances at this kind of spreading rate. Comparisons with tissue collected years before the eruption showed the post-eruption population was not a genetically distinct newcomer group, suggesting the same regional population reseeded the affected vents. The authors suggest the general pattern, bacterial dominance giving way to worm-driven structural complexity that in turn shapes the grazer community, could hold at other similarly disturbed vent systems, though more post-eruption studies elsewhere would be needed to confirm it.`;

// --- Control 2: generic academic boilerplate, no distinctive content at all ---
const BOILERPLATE_ONLY = `This study aims to investigate the research problem outlined above using a mixed-methods approach. The results suggest that further research is needed to fully understand the underlying mechanisms at play. Several limitations of this study should be acknowledged, including sample size and the scope of the analysis. Future work should address these limitations and explore additional variables that may influence the outcomes observed. In conclusion, the findings contribute to the broader body of literature on this topic, although additional studies are required to generalize these results across different populations and contexts. The implications of these findings for practice and policy are discussed in the sections that follow, along with recommendations for future research directions in this area.`;

// --- Control 3: a genuine paraphrase of a real, previously-uploaded document (light rewrite, not a copy) ---
const REFERENCE_PARAPHRASE = `Along the imaginary Kelmar spreading ridge, vent-dwelling organisms have given scientists a rare, well-timed look at how chemosynthesis-based communities rebuild after an eruption. Over roughly five years, the team returned to the same six vent openings every year and a half, using a submersible with a manipulator arm and temperature/conductivity sensors to record conditions around each site. No tubeworm clusters were present at the newly exposed openings right after the eruption, yet by the third visit they had grown to cover nearly the maximum possible area, recovering faster than similar cases documented at other slower-spreading ridges elsewhere.`;

{
  const original = realArchiveAnalyze(TOPICAL_PARAPHRASE);
  const live = await getExternalAcademicEvidence(TOPICAL_PARAPHRASE);
  const unified = computeUnifiedSimilarity({ wordCount: original.wordCount, archiveMatchedPositions: original.archiveMatchedPositions, externalAcademicEvidence: live.evidence });
  record("Control 1: topical similarity (same subject, fully independent wording)", {
    wordCount: original.wordCount,
    realArchiveMatchedWordCount: original.matchedWordCount,
    realLiveEvidenceCount: live.evidence.length,
    unifiedScore: unified.unifiedScore,
    expectation: "near-zero — same TOPIC as REFERENCE_TEXT but no shared 5-word shingles/live confirmation, since the matcher is textual, not semantic",
  });
}

{
  const original = realArchiveAnalyze(BOILERPLATE_ONLY);
  const live = await getExternalAcademicEvidence(BOILERPLATE_ONLY);
  const unified = computeUnifiedSimilarity({ wordCount: original.wordCount, archiveMatchedPositions: original.archiveMatchedPositions, externalAcademicEvidence: live.evidence });
  record("Control 2: generic academic boilerplate only, no distinctive content", {
    wordCount: original.wordCount,
    realArchiveMatchedWordCount: original.matchedWordCount,
    realLiveEvidenceCount: live.evidence.length,
    unifiedScore: unified.unifiedScore,
    expectation: "near-zero — common phrasing alone must not accumulate into a meaningful match",
  });
}

{
  const original = realArchiveAnalyze(REFERENCE_PARAPHRASE);
  const live = await getExternalAcademicEvidence(REFERENCE_PARAPHRASE);
  const unified = computeUnifiedSimilarity({ wordCount: original.wordCount, archiveMatchedPositions: original.archiveMatchedPositions, externalAcademicEvidence: live.evidence });
  record("Control 3: genuine paraphrase of a real prior document (own-style rewrite, not a copy)", {
    wordCount: original.wordCount,
    realArchiveMatchedWordCount: original.matchedWordCount,
    realLiveEvidenceCount: live.evidence.length,
    unifiedScore: unified.unifiedScore,
    note: "prior-submission-corpus matching against REFERENCE_TEXT is intentionally not exercised here (requires the DB-backed matcher) — this control isolates the archive+live layers only, both of which are textual/shingle-based, not semantic",
    expectation: "near-zero on archive/live — paraphrasing in the author's own words/structure is acceptable per product philosophy and should not trigger textual-reuse evidence",
  });
}

// --- Performance measurements ---
{
  const archiveTimings = [];
  for (const text of [REFERENCE_TEXT, TOPICAL_PARAPHRASE, BOILERPLATE_ONLY]) {
    const start = performance.now();
    realArchiveAnalyze(text);
    archiveTimings.push(performance.now() - start);
  }
  results.performance.realArchiveAnalyzeMs = archiveTimings;

  const unifiedTimings = [];
  const bigPositions = Array.from({ length: 5000 }, (_, i) => i);
  for (let i = 0; i < 20; i += 1) {
    const start = performance.now();
    computeUnifiedSimilarity({
      wordCount: 10000,
      archiveMatchedPositions: bigPositions,
      externalAcademicEvidence: [{ provider: "openaire", providerId: "p", title: null, authors: null, publication: null, year: null, doi: null, url: null, similarity: 90, matchedPassages: [{ submittedText: "", submittedWordStart: 4000, submittedWordEnd: 4999, matchedWordCount: 1000 }] }],
      historicalSubmissionMatch: { status: "MATCHED", computedAt: new Date().toISOString(), matcherVersion: "v", fingerprintVersion: "v", canonicalizationVersion: "v", matches: [{ relationshipType: "PRIOR_SUBMISSION", matchedRepresentationId: "r", matchType: "STRONG_TEXT_MATCH", containment: 0.8, matchedWordCount: 1000, passageCount: 1, longestMatchWords: 1000, passages: [{ submittedText: "", submittedWordStart: 6000, submittedWordEnd: 6999, matchedWordCount: 1000 }], historicalSubmissionCount: 1 }] },
    });
    unifiedTimings.push(performance.now() - start);
  }
  results.performance.computeUnifiedSimilarityMs_10kWordDoc = unifiedTimings;
}

const outputPath = path.join(import.meta.dirname, "phase6-5-false-positive-and-perf-results.json");
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
console.log(`\n\nWrote results to ${outputPath}`);
