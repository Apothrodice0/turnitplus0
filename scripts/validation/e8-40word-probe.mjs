// Probe: does the EXISTING E8L/E8M/E8N tooling correctly separate a
// genuinely distinctive 40-word passage from a generic ~20-word boilerplate
// passage, both embedded in a short (~150-160 word) document — the exact
// scale of Phase 6.5's real "40 words in 156" finding, which none of E8N's
// existing fixtures specifically test (smallest tested generic fixture is
// 100 words). NOT a committed test — a one-off calibration probe.
import { buildBackgroundCorpus, generateGenericDocument, generateDistinctiveDocument, MASTER_GENERIC_DOCUMENT } from "../../lib/e8l-calibration-corpus.ts";
import { buildCorpusFrequencyIndex } from "../../lib/e8l-distinctiveness-v2.ts";
import { evaluateVariant } from "../../lib/e8n-pipeline-evaluator.ts";
import { canonicalizeText } from "../../lib/canonical-text.ts";

const corpus = buildBackgroundCorpus();
const freqIndex = buildCorpusFrequencyIndex(corpus.map((d) => ({ id: d.id, canonicalText: d.canonicalText })));
const localCorpusContext = corpus.map((d) => ({ id: d.id, canonicalText: d.canonicalText }));

function padded(excerpt, label) {
  const before = `Independent original commentary precedes the borrowed material below, written for a validation probe, describing an unrelated ${label} topic entirely.`;
  const after = `A closing paragraph, again unrelated, discusses a separate logistics topic included only to give this document realistic surrounding length for the probe.`;
  return `${before} ${excerpt} ${after}`;
}

// Genuinely distinctive 40-word passage (reused verbatim from Phase 6.5's
// own real vent-ecology fixture, already proven distinctive/non-generic).
const DISTINCTIVE_40 = "The research team interpreted this decline as evidence of active ecosystem engineering by the tubeworms themselves rather than a simple consequence of diffuse flow chemistry drifting away from conditions favorable to the mat forming taxa";
console.log("distinctive excerpt word count:", DISTINCTIVE_40.split(/\s+/).length);

// A generic/boilerplate ~20-word passage, drawn from E8L's own
// GENERIC_SENTENCE_BANK-backed generator (the same source E8N's own
// COMMON_BOILERPLATE fixtures use).
const GENERIC_20_SOURCE = generateGenericDocument(42, 3);
const GENERIC_20 = GENERIC_20_SOURCE.split(/\s+/).slice(0, 20).join(" ");
console.log("generic excerpt word count:", GENERIC_20.split(/\s+/).length);
console.log("generic excerpt text:", GENERIC_20);

const distinctiveSubmitted = canonicalizeText(padded(DISTINCTIVE_40, "vent ecology"));
const distinctiveCandidate = canonicalizeText(`${DISTINCTIVE_40} This is the original source document containing this distinctive passage along with substantial additional original source-only material padding the source out to a realistic full document length so containment against the excerpt alone stays low, exactly mirroring Phase 6.5's real 156-word-source finding.`);

const genericSubmitted = canonicalizeText(padded(GENERIC_20, "unrelated"));
const genericCandidate = canonicalizeText(`${GENERIC_20} ${MASTER_GENERIC_DOCUMENT}`);

for (const [label, submitted, candidate] of [
  ["DISTINCTIVE_40_IN_SHORT_DOC", distinctiveSubmitted, distinctiveCandidate],
  ["GENERIC_20_IN_SHORT_DOC", genericSubmitted, genericCandidate],
]) {
  console.log(`\n=== ${label} ===`);
  for (const variant of ["A_V0_ONLY", "D_V0_V2", "F_E8M_V2"]) {
    const result = evaluateVariant(variant, submitted, candidate, { freqIndex, localCorpusContext });
    console.log(`  ${variant}: matched=${result.matchedWordCount} longest=${result.longestMatchWords} passages=${result.passageCount} density=${result.passageDensity.toFixed(3)} distinctiveness=${result.distinctiveness === null ? "n/a" : result.distinctiveness.toFixed(3)}`);
  }
}
