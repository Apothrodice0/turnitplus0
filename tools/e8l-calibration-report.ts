import fs from "node:fs";
import path from "node:path";
import {
  buildBackgroundCorpus, buildQueryFixtures, generateGenericDocument, generateDistinctiveDocument,
  type QueryFixture, type QueryLabel, type CorpusDocument,
} from "../lib/e8l-calibration-corpus";
import { buildCorpusFrequencyIndex, computeFeatures, type V2Diagnostics } from "../lib/e8l-distinctiveness-v2";
import { evaluatePassages, type PassageLevelDiagnostics } from "../lib/e8k-passage-evaluator";
import { evaluateExperimentalAcceptance, PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS, type PassageLevelExperimentalThresholds } from "../lib/e8k-passage-acceptance";

/**
 * Phase E8L: calibration report comparing the E8K baseline distinctiveness
 * model (V1) against the redesigned V2 model, on a ~115-document synthetic
 * local corpus. Pure-function comparisons — no database, no production
 * connection, no production threshold/matcher import anywhere.
 *
 * Usage: node --import tsx tools/e8l-calibration-report.ts
 */

function fmt(n: number, d = 3) { return n.toFixed(d); }

// "Reuse" labels are the ones a real passage-level acceptance path SHOULD
// eventually detect; GENERIC/COMMON_BOILERPLATE/SAME_TOPIC_INDEPENDENT
// should NOT be detected as reuse.
const REUSE_LABELS: QueryLabel[] = ["DISTINCTIVE_COPY", "LIGHT_REUSE", "MODERATE_REUSE", "HEAVY_REUSE", "PARTIAL_COPY", "MULTI_BLOCK_COPY"];
function expectedShouldDetect(label: QueryLabel): boolean {
  return REUSE_LABELS.includes(label);
}

type EvaluatedFixture = {
  fixture: QueryFixture;
  v1: PassageLevelDiagnostics;
  v2: V2Diagnostics;
  v1Pass: boolean;
  v2Pass: boolean; // V1's acceptance mechanics, with V1's distinctiveness swapped for V2's — isolates the distinctiveness signal specifically
};

function evaluateFixture(f: QueryFixture, corpus: CorpusDocument[], freqIndex: ReturnType<typeof buildCorpusFrequencyIndex>): EvaluatedFixture {
  const v1 = evaluatePassages(f.text, f.candidateText, { localCorpusContext: corpus.map((d) => ({ id: d.id, canonicalText: d.canonicalText })) });
  const v2 = computeFeatures(f.text, f.candidateText, freqIndex);
  const v1Result = evaluateExperimentalAcceptance(v1);
  const v2ProxyDiagnostics: PassageLevelDiagnostics = { ...v1, distinctiveness: v2.distinctivenessV2, distinctivenessBand: v2.distinctivenessV2 >= 0.66 ? "high" : v2.distinctivenessV2 >= 0.33 ? "medium" : "low" };
  const v2Result = evaluateExperimentalAcceptance(v2ProxyDiagnostics, { ...PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS, minimumDistinctiveness: 0.5 });
  return { fixture: f, v1, v2, v1Pass: v1Result.pass, v2Pass: v2Result.pass };
}

function printRow(e: EvaluatedFixture) {
  const expected = expectedShouldDetect(e.fixture.label);
  const v1Correct = e.v1Pass === expected;
  const v2Correct = e.v2Pass === expected;
  console.log(
    `${e.fixture.id.padEnd(32)} label=${e.fixture.label.padEnd(24)} split=${e.fixture.split.padEnd(9)} ` +
    `v1_dist=${fmt(e.v1.distinctiveness)} v2_dist=${fmt(e.v2.distinctivenessV2)} v1_pass=${String(e.v1Pass).padEnd(5)}${v1Correct ? " " : "*"} v2_pass=${String(e.v2Pass).padEnd(5)}${v2Correct ? " " : "*"}`,
  );
}

async function main() {
  console.log("=".repeat(110));
  console.log("PHASE E8L — PASSAGE DISTINCTIVENESS REDESIGN & CALIBRATION REPORT");
  console.log("=".repeat(110));
  console.log("Pure-function comparisons only — no database, no production connection anywhere in this file.\n");

  const corpusStart = performance.now();
  const corpus = buildBackgroundCorpus();
  const freqIndex = buildCorpusFrequencyIndex(corpus);
  const corpusBuildMs = performance.now() - corpusStart;
  console.log(`background corpus: ${corpus.length} documents (${corpus.filter((d) => d.label === "GENERIC").length} GENERIC, ${corpus.filter((d) => d.label === "DISTINCTIVE").length} DISTINCTIVE, ${corpus.filter((d) => d.label === "SOURCE").length} SOURCE, ${corpus.filter((d) => d.label === "INDEPENDENT").length} INDEPENDENT), index built in ${fmt(corpusBuildMs, 1)}ms`);

  const { fixtures, adversarialGeneric, adversarialDistinctive } = buildQueryFixtures(corpus);
  console.log(`query fixtures: ${fixtures.length} labeled cases (${fixtures.filter((f) => f.split === "train").length} train, ${fixtures.filter((f) => f.split === "holdout").length} holdout, ${fixtures.filter((f) => f.split === "landmark").length} landmark)\n`);

  const evaluated = fixtures.map((f) => evaluateFixture(f, corpus, freqIndex));
  const evaluatedAdvGeneric = adversarialGeneric.map((f) => evaluateFixture(f, corpus, freqIndex));
  const evaluatedAdvDistinctive = adversarialDistinctive.map((f) => evaluateFixture(f, corpus, freqIndex));

  console.log("-".repeat(110));
  console.log("SECTION A: FEATURE-BY-FEATURE RESULTS (V2's 9 features, by label — before combining)");
  console.log("-".repeat(110));
  const labelsForFeatureReport: QueryLabel[] = ["GENERIC", "COMMON_BOILERPLATE", "DISTINCTIVE_COPY", "LIGHT_REUSE", "PARTIAL_COPY", "SAME_TOPIC_INDEPENDENT"];
  for (const label of labelsForFeatureReport) {
    const group = evaluated.filter((e) => e.fixture.label === label);
    if (group.length === 0) continue;
    const avg = (sel: (e: EvaluatedFixture) => number) => group.reduce((s, e) => s + sel(e), 0) / group.length;
    console.log(`${label} (n=${group.length}):`);
    console.log(`  A corpusFrequency=${fmt(avg((e) => e.v2.features.corpusFrequency))}  B shingleFrequency=${fmt(avg((e) => e.v2.features.shingleFrequency))}  C phraseLengthWords=${fmt(avg((e) => e.v2.features.phraseLengthWords), 1)}`);
    console.log(`  D tokenIdf=${fmt(avg((e) => e.v2.features.tokenIdf))}  E rareMultiword=${fmt(avg((e) => e.v2.features.rareMultiword))}  F entitySignal=${fmt(avg((e) => e.v2.features.entitySignal))}`);
    console.log(`  G numericSignal=${fmt(avg((e) => e.v2.features.numericSignal))}  H contiguity=${fmt(avg((e) => e.v2.features.contiguity))}  I internalRepetition=${fmt(avg((e) => e.v2.features.internalRepetition))}`);
    console.log(`  -> V1 distinctiveness=${fmt(avg((e) => e.v1.distinctiveness))}  V2 distinctiveness=${fmt(avg((e) => e.v2.distinctivenessV2))}`);
  }

  console.log("\n" + "-".repeat(110));
  console.log("SECTION B: PER-FIXTURE V1 vs V2 (train split)");
  console.log("-".repeat(110));
  for (const e of evaluated.filter((x) => x.fixture.split === "train")) printRow(e);

  console.log("\n" + "-".repeat(110));
  console.log("SECTION C: HOLD-OUT SET (weights/thresholds were not tuned against these)");
  console.log("-".repeat(110));
  for (const e of evaluated.filter((x) => x.fixture.split === "holdout")) printRow(e);

  console.log("\n" + "-".repeat(110));
  console.log("SECTION D: LANDMARK FIXTURES (reused verbatim from E8J/E8K, evaluated after weight selection)");
  console.log("-".repeat(110));
  for (const e of evaluated.filter((x) => x.fixture.split === "landmark")) printRow(e);

  function confusionMatrix(rows: EvaluatedFixture[], usingV2: boolean) {
    const byLabel = new Map<QueryLabel, { tp: number; fp: number; tn: number; fn: number }>();
    for (const e of rows) {
      const expected = expectedShouldDetect(e.fixture.label);
      const predicted = usingV2 ? e.v2Pass : e.v1Pass;
      const cell = byLabel.get(e.fixture.label) ?? { tp: 0, fp: 0, tn: 0, fn: 0 };
      if (expected && predicted) cell.tp += 1;
      else if (!expected && predicted) cell.fp += 1;
      else if (!expected && !predicted) cell.tn += 1;
      else cell.fn += 1;
      byLabel.set(e.fixture.label, cell);
    }
    return byLabel;
  }

  console.log("\n" + "-".repeat(110));
  console.log("SECTION E: CONFUSION MATRIX (all non-adversarial fixtures, train+holdout+landmark)");
  console.log("-".repeat(110));
  for (const usingV2 of [false, true]) {
    console.log(`  ${usingV2 ? "V2" : "V1"}:`);
    const matrix = confusionMatrix(evaluated, usingV2);
    let totalTp = 0, totalFp = 0, totalTn = 0, totalFn = 0;
    for (const [label, cell] of matrix) {
      console.log(`    ${label.padEnd(24)} predicted-reuse=${cell.tp + cell.fp}  predicted-generic=${cell.tn + cell.fn}  (tp=${cell.tp} fp=${cell.fp} tn=${cell.tn} fn=${cell.fn})`);
      totalTp += cell.tp; totalFp += cell.fp; totalTn += cell.tn; totalFn += cell.fn;
    }
    const precision = totalTp / Math.max(1, totalTp + totalFp);
    const recall = totalTp / Math.max(1, totalTp + totalFn);
    const f1 = 2 * (precision * recall) / Math.max(1e-9, precision + recall);
    console.log(`    TOTAL: precision=${fmt(precision)} recall=${fmt(recall)} f1=${fmt(f1)} (calibration metrics on the synthetic dataset only, NOT production performance)`);
  }

  console.log("\n" + "-".repeat(110));
  console.log("SECTION F: ADVERSARIAL GENERIC (section 14 — long boilerplate, repeated methodology, legal language, mixed stitching)");
  console.log("-".repeat(110));
  for (const e of evaluatedAdvGeneric) printRow(e);

  console.log("\n" + "-".repeat(110));
  console.log("SECTION G: ADVERSARIAL DISTINCTIVE (section 15 — small edits: entity swap, number change, punctuation, sentence merge)");
  console.log("-".repeat(110));
  for (const e of evaluatedAdvDistinctive) printRow(e);

  console.log("\n" + "-".repeat(110));
  console.log("SECTION H: HEADLINE SEPARATION GAP — can ANY threshold separate GENERIC from DISTINCTIVE_COPY under each model?");
  console.log("-".repeat(110));
  {
    const genericV1 = evaluated.filter((e) => e.fixture.label === "GENERIC" || e.fixture.label === "COMMON_BOILERPLATE").map((e) => e.v1.distinctiveness);
    const genericV2 = evaluated.filter((e) => e.fixture.label === "GENERIC" || e.fixture.label === "COMMON_BOILERPLATE").map((e) => e.v2.distinctivenessV2);
    const distinctiveV1 = evaluated.filter((e) => e.fixture.label === "DISTINCTIVE_COPY").map((e) => e.v1.distinctiveness);
    const distinctiveV2 = evaluated.filter((e) => e.fixture.label === "DISTINCTIVE_COPY").map((e) => e.v2.distinctivenessV2);
    const maxOf = (a: number[]) => Math.max(...a);
    const minOf = (a: number[]) => Math.min(...a);
    console.log(`  V1: GENERIC/BOILERPLATE range [${fmt(minOf(genericV1))}, ${fmt(maxOf(genericV1))}]  vs  DISTINCTIVE_COPY range [${fmt(minOf(distinctiveV1))}, ${fmt(maxOf(distinctiveV1))}]  ${maxOf(genericV1) < minOf(distinctiveV1) ? "-> a separating threshold EXISTS" : "-> RANGES OVERLAP, no threshold can cleanly separate them"}`);
    console.log(`  V2: GENERIC/BOILERPLATE range [${fmt(minOf(genericV2))}, ${fmt(maxOf(genericV2))}]  vs  DISTINCTIVE_COPY range [${fmt(minOf(distinctiveV2))}, ${fmt(maxOf(distinctiveV2))}]  ${maxOf(genericV2) < minOf(distinctiveV2) ? "-> a separating threshold EXISTS" : "-> RANGES OVERLAP, no threshold can cleanly separate them"}`);
  }

  function runSweep(rows: EvaluatedFixture[], distinctivenessOf: (e: EvaluatedFixture) => number) {
    const sweepDims = { matchedWords: [50, 100, 150, 250, 400], longest: [50, 100, 150, 250, 400], density: [0.05, 0.1, 0.2, 0.3], distinctiveness: [0, 0.3, 0.5, 0.7, 0.85] };
    let best: { thresholds: PassageLevelExperimentalThresholds; correct: number; total: number } | null = null;
    const results: { thresholds: PassageLevelExperimentalThresholds; genericFP: number; reuseRecall: number; correct: number }[] = [];
    for (const mw of sweepDims.matchedWords) for (const lw of sweepDims.longest) for (const dens of sweepDims.density) for (const dist of sweepDims.distinctiveness) {
      const thresholds: PassageLevelExperimentalThresholds = { minimumMatchedWords: mw, minimumLongestPassageWords: lw, minimumPassageDensity: dens, minimumInformativeSharedShingles: 15, minimumMeaningfulPassages: 1, minimumDistinctiveness: dist };
      let correct = 0, genericTotal = 0, genericFP = 0, reuseTotal = 0, reuseDetected = 0;
      for (const e of rows) {
        const proxy: PassageLevelDiagnostics = { ...e.v1, distinctiveness: distinctivenessOf(e), distinctivenessBand: "medium" };
        const { pass } = evaluateExperimentalAcceptance(proxy, thresholds);
        const expected = expectedShouldDetect(e.fixture.label);
        if (pass === expected) correct += 1;
        if (!expected) { genericTotal += 1; if (pass) genericFP += 1; }
        else { reuseTotal += 1; if (pass) reuseDetected += 1; }
      }
      const result = { thresholds, genericFP: genericFP / Math.max(1, genericTotal), reuseRecall: reuseDetected / Math.max(1, reuseTotal), correct };
      results.push(result);
      if (!best || correct > best.correct) best = { thresholds, correct, total: rows.length };
    }
    return { results, best: best! };
  }

  console.log("\n" + "-".repeat(110));
  console.log("SECTION I: THRESHOLD SWEEP — V1 vs V2, both on train+landmark split only");
  console.log("-".repeat(110));
  const trainRows = evaluated.filter((e) => e.fixture.split === "train" || e.fixture.split === "landmark");
  const sweepV1 = runSweep(trainRows, (e) => e.v1.distinctiveness);
  const sweepV2 = runSweep(trainRows, (e) => e.v2.distinctivenessV2);
  console.log(`swept ${sweepV1.results.length} combinations on ${trainRows.length} train+landmark rows, for each of V1 and V2`);
  console.log(`  V1 best: correct=${sweepV1.best.correct}/${sweepV1.best.total} thresholds=${JSON.stringify(sweepV1.best.thresholds)}`);
  console.log(`  V2 best: correct=${sweepV2.best.correct}/${sweepV2.best.total} thresholds=${JSON.stringify(sweepV2.best.thresholds)}`);
  for (const [label, sweep] of [["V1", sweepV1], ["V2", sweepV2]] as const) {
    const zeroFP = sweep.results.filter((r) => r.genericFP === 0).sort((a, b) => b.reuseRecall - a.reuseRecall);
    console.log(`  ${label} best zero-generic-false-positive combination: ${zeroFP.length > 0 ? `recall=${fmt(zeroFP[0].reuseRecall)} thresholds=${JSON.stringify(zeroFP[0].thresholds)}` : "NONE FOUND in the swept grid"}`);
  }

  console.log("\n" + "-".repeat(110));
  console.log("SECTION J: HOLD-OUT VALIDATION using each model's own best train-only threshold combination (no further tuning)");
  console.log("-".repeat(110));
  for (const [label, sweep, distinctivenessOf] of [
    ["V1", sweepV1, (e: EvaluatedFixture) => e.v1.distinctiveness],
    ["V2", sweepV2, (e: EvaluatedFixture) => e.v2.distinctivenessV2],
  ] as const) {
    const holdoutRows = evaluated.filter((e) => e.fixture.split === "holdout");
    let correct = 0;
    for (const e of holdoutRows) {
      const proxy: PassageLevelDiagnostics = { ...e.v1, distinctiveness: distinctivenessOf(e), distinctivenessBand: "medium" };
      const { pass } = evaluateExperimentalAcceptance(proxy, sweep.best.thresholds);
      const expected = expectedShouldDetect(e.fixture.label);
      if (pass === expected) correct += 1;
    }
    console.log(`  ${label} hold-out accuracy using its own best train threshold: ${correct}/${holdoutRows.length} (${fmt(correct / Math.max(1, holdoutRows.length))})`);
  }

  console.log("\n" + "-".repeat(110));
  console.log("SECTION K: SCORE SEPARATION (structural)");
  console.log("-".repeat(110));
  function stripComments(source: string) { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }
  for (const file of ["lib/e8l-calibration-corpus.ts", "lib/e8l-distinctiveness-v2.ts"]) {
    const source = stripComments(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
    console.log(`${file}: references scoring field=${/\b(archiveScore|report\.score|aiScore|verifiedSimilarity)\b/.test(source) ? "YES-INVESTIGATE" : "no"}, imports production matcher=${/from\s+["'].*user-submission-matching["']/.test(source) ? "YES-INVESTIGATE" : "no"}, imports DB client=${/@libsql\/client/.test(source) ? "YES-INVESTIGATE" : "no"}`);
  }

  console.log("\n" + "-".repeat(110));
  console.log("SECTION L: PERFORMANCE — index build + per-query evaluation at scale");
  console.log("-".repeat(110));
  for (const size of [100, 300, 1000]) {
    const bigCorpus: CorpusDocument[] = [];
    for (let i = 0; i < size; i += 1) {
      const useGeneric = i % 2 === 0;
      bigCorpus.push({
        id: `perf-${i}`,
        label: useGeneric ? "GENERIC" : "DISTINCTIVE",
        canonicalText: useGeneric ? generateGenericDocument(80000 + i, 12) : generateDistinctiveDocument(80000 + i, 10),
      });
    }
    const buildStart = performance.now();
    const bigIndex = buildCorpusFrequencyIndex(bigCorpus);
    const buildMs = performance.now() - buildStart;

    const queryStart = performance.now();
    const queryDiag = computeFeatures(evaluated[0].fixture.text, evaluated[0].fixture.candidateText, bigIndex);
    const queryMs = performance.now() - queryStart;
    console.log(`corpus size ${size}: index build=${fmt(buildMs, 1)}ms, single query distinctiveness computation=${fmt(queryMs, 2)}ms, distinctivenessV2=${fmt(queryDiag.distinctivenessV2)}`);
  }

  console.log("\n" + "=".repeat(110));
  console.log("REPORT COMPLETE.");
  console.log("=".repeat(110));
}

main().catch((err) => {
  console.error("e8l-calibration-report failed:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
