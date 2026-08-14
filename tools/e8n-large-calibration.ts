import fs from "node:fs";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest";
import { createReusableDocumentRepresentation, recordCorpusShingles, findCandidateCorpusRepresentations, findRepresentationById, corpusShingleHashes } from "../lib/user-submission-corpus";
import { canonicalizeText } from "../lib/canonical-text";
import { computeDocumentCorrespondence, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS } from "../lib/document-correspondence";
import { computeRobustCorrespondence, DEFAULT_ROBUST_CORRESPONDENCE_CONFIG, type RobustCorrespondenceConfig } from "../lib/e8m-robust-correspondence";
import { generateGenericDocument, generateDistinctiveDocument, MASTER_GENERIC_DOCUMENT } from "../lib/e8l-calibration-corpus";
import {
  PIPELINE_VARIANTS, evaluateVariant, evaluateExperimentalAcceptance, sweepThresholds, classifyFailure,
  v1DistinctivenessFromCorrespondence, v2DistinctivenessFromCorrespondence,
  PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS, type PipelineVariant, type PipelineEvaluation, type PassageLevelExperimentalThresholds,
} from "../lib/e8n-pipeline-evaluator";
import { buildE8NDataset, buildPerturbationBattery, type E8NFixture, type E8NDataset } from "../lib/e8n-calibration-dataset";
import { tokens } from "../lib/similarity-core";

/**
 * Phase E8N: large-corpus re-calibration report. Pure-function comparisons
 * for most sections; only the performance section connects to a disposable
 * local SQLite file, never production.
 *
 * Usage: node --import tsx tools/e8n-large-calibration.ts
 */

function fmt(n: number, d = 3) { return n.toFixed(d); }

const dataset = buildE8NDataset();
const ALL_FIXTURES: E8NFixture[] = [...dataset.fixtures, ...dataset.appendedFixtures];

type Evaluated = { fixture: E8NFixture; byVariant: Record<PipelineVariant, PipelineEvaluation> };

function evaluateFixtureAllVariants(f: E8NFixture): Evaluated {
  const byVariant = {} as Record<PipelineVariant, PipelineEvaluation>;
  for (const variant of PIPELINE_VARIANTS) {
    byVariant[variant] = evaluateVariant(variant, f.text, f.candidateText, {
      freqIndex: dataset.freqIndex,
      localCorpusContext: dataset.corpus.map((d) => ({ id: d.id, canonicalText: d.canonicalText })),
    });
  }
  return { fixture: f, byVariant };
}

function passVariant(evaluation: PipelineEvaluation, thresholds: PassageLevelExperimentalThresholds = PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS): boolean {
  const proxy = { matchedWordCount: evaluation.matchedWordCount, longestMatchWords: evaluation.longestMatchWords, passageCount: evaluation.passageCount, passageDensity: evaluation.passageDensity, informativeSharedShingleCount: evaluation.matchedWordCount > 0 ? 9999 : 0, distinctiveness: evaluation.distinctiveness ?? 1, distinctivenessBand: "medium" as const, isExactCanonicalMatch: false, wholeDocumentContainment: evaluation.containment, passages: [], averagePassageLengthWords: 0, passageCoverage: 0 };
  return evaluateExperimentalAcceptance(proxy, thresholds).pass;
}

async function main() {
  console.log("=".repeat(118));
  console.log("PHASE E8N — LARGE-CORPUS RE-CALIBRATION REPORT (V0/E8M correspondence x V1/V2 distinctiveness, 6 variants)");
  console.log("=".repeat(118));
  console.log(`corpus: ${dataset.corpus.length} documents (reused from lib/e8l-calibration-corpus.ts unmodified)`);
  console.log(`fixtures: ${dataset.fixtures.length} from E8L (train=${dataset.fixtures.filter((f) => f.split === "train").length}, holdout=${dataset.fixtures.filter((f) => f.split === "holdout").length}, landmark=${dataset.fixtures.filter((f) => f.split === "landmark").length}), plus ${dataset.appendedFixtures.length} E8N-appended (split="appended", reported separately)\n`);

  const evaluated = ALL_FIXTURES.map(evaluateFixtureAllVariants);

  console.log("-".repeat(118));
  console.log("SECTION 1: PER-FIXTURE, ALL 6 VARIANTS (train + landmark)");
  console.log("-".repeat(118));
  for (const e of evaluated.filter((x) => x.fixture.split === "train" || x.fixture.split === "landmark")) {
    const parts = PIPELINE_VARIANTS.map((v) => {
      const ev = e.byVariant[v];
      const pass = passVariant(ev);
      const correct = pass === e.fixture.expectedShouldDetect;
      return `${v.split("_")[0]}=${pass ? "R" : "."}${correct ? "" : "*"}`;
    }).join(" ");
    console.log(`${e.fixture.id.padEnd(34)} label=${e.fixture.evaluationLabel.padEnd(22)} expected=${e.fixture.expectedShouldDetect ? "reuse   " : "generic "} [${parts}]`);
  }
  console.log("(R=detected, .=rejected, *=incorrect vs expected; columns A_V0 B_E8M C_V0V1 D_V0V2 E_E8MV1 F_E8MV2)");

  for (const split of ["train", "landmark", "holdout", "appended"] as const) {
    console.log(`\nTOTALS for split=${split}:`);
    for (const variant of PIPELINE_VARIANTS) {
      const rows = evaluated.filter((e) => e.fixture.split === split);
      const correct = rows.filter((e) => passVariant(e.byVariant[variant]) === e.fixture.expectedShouldDetect).length;
      console.log(`  ${variant.padEnd(10)} correct=${correct}/${rows.length}`);
    }
  }

  console.log("\n" + "-".repeat(118));
  console.log("SECTION 2: CONFUSION MATRICES — TRAIN+LANDMARK (exploration) vs LOCKED HOLDOUT (final, untouched)");
  console.log("-".repeat(118));
  function confusion(rows: Evaluated[], variant: PipelineVariant) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const e of rows) {
      const predicted = passVariant(e.byVariant[variant]);
      const expected = e.fixture.expectedShouldDetect;
      if (expected && predicted) tp += 1;
      else if (!expected && predicted) fp += 1;
      else if (!expected && !predicted) tn += 1;
      else fn += 1;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const f1 = 2 * (precision * recall) / Math.max(1e-9, precision + recall);
    return { tp, fp, tn, fn, precision, recall, f1 };
  }
  for (const [label, rows] of [["TRAIN+LANDMARK", evaluated.filter((e) => e.fixture.split === "train" || e.fixture.split === "landmark")], ["LOCKED HOLDOUT", evaluated.filter((e) => e.fixture.split === "holdout")]] as const) {
    console.log(`\n  ${label} (n=${rows.length}):`);
    for (const variant of PIPELINE_VARIANTS) {
      const c = confusion(rows, variant);
      console.log(`    ${variant.padEnd(10)} tp=${c.tp} fp=${c.fp} tn=${c.tn} fn=${c.fn}  precision=${fmt(c.precision)} recall=${fmt(c.recall)} f1=${fmt(c.f1)} (synthetic-calibration metric only)`);
    }
  }

  // ===================================================================
  // SECTION 3: THRESHOLD SWEEP (TRAIN+LANDMARK ONLY) — acceptance-rule dimensions per variant
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 3: THRESHOLD SWEEP — acceptance-rule dimensions, TRAIN+LANDMARK ONLY (holdout never consulted here)");
  console.log("-".repeat(118));
  const trainLandmarkRows = evaluated.filter((e) => e.fixture.split === "train" || e.fixture.split === "landmark");
  const bestThresholdsByVariant = {} as Record<PipelineVariant, PassageLevelExperimentalThresholds>;
  for (const variant of PIPELINE_VARIANTS) {
    const sweepInputs = trainLandmarkRows.map((e) => ({ category: e.fixture.evaluationLabel, diagnostics: { matchedWordCount: e.byVariant[variant].matchedWordCount, passageCount: e.byVariant[variant].passageCount, longestMatchWords: e.byVariant[variant].longestMatchWords, passageDensity: e.byVariant[variant].passageDensity, informativeSharedShingleCount: e.byVariant[variant].matchedWordCount > 0 ? 9999 : 0, distinctiveness: e.byVariant[variant].distinctiveness ?? 1, distinctivenessBand: "medium" as const, isExactCanonicalMatch: false, wholeDocumentContainment: e.byVariant[variant].containment, passages: [], averagePassageLengthWords: 0, passageCoverage: 0 }, expectedShouldDetect: e.fixture.expectedShouldDetect }));
    const swept = sweepThresholds(sweepInputs, {
      minimumMatchedWordsOptions: [50, 100, 150, 250, 400],
      minimumLongestPassageWordsOptions: [50, 100, 150, 250, 400],
      minimumPassageDensityOptions: [0.05, 0.1, 0.2, 0.3],
      minimumDistinctivenessOptions: variant.startsWith("A") || variant.startsWith("B") ? [0] : [0, 0.3, 0.5, 0.7, 0.85],
    });
    const best = [...swept].sort((a, b) => b.correctCount - a.correctCount)[0];
    bestThresholdsByVariant[variant] = best.thresholds;
    console.log(`  ${variant.padEnd(10)} best: correct=${best.correctCount}/${best.totalCount} thresholds=${JSON.stringify(best.thresholds)}`);
  }

  console.log("\n  anchorSize x gapTolerance sweep for E8M-based variants (B/E/F), acceptance thresholds held at each variant's own best above:");
  for (const anchorSize of [3, 4, 5, 6]) {
    for (const gapTolerance of [1, 3, 5]) {
      const config: RobustCorrespondenceConfig = { ...DEFAULT_ROBUST_CORRESPONDENCE_CONFIG, anchorSize, gapTolerance };
      let correctB = 0, correctF = 0;
      for (const e of trainLandmarkRows) {
        const evB = evaluateVariant("B_E8M_ONLY", e.fixture.text, e.fixture.candidateText, { freqIndex: dataset.freqIndex, localCorpusContext: [], e8mConfig: config });
        const evF = evaluateVariant("F_E8M_V2", e.fixture.text, e.fixture.candidateText, { freqIndex: dataset.freqIndex, localCorpusContext: dataset.corpus.map((d) => ({ id: d.id, canonicalText: d.canonicalText })), e8mConfig: config });
        if (passVariant(evB, bestThresholdsByVariant.B_E8M_ONLY) === e.fixture.expectedShouldDetect) correctB += 1;
        if (passVariant(evF, bestThresholdsByVariant.F_E8M_V2) === e.fixture.expectedShouldDetect) correctF += 1;
      }
      console.log(`    anchorSize=${anchorSize} gapTolerance=${gapTolerance}: B_E8M_ONLY correct=${correctB}/${trainLandmarkRows.length}, F_E8M_V2 correct=${correctF}/${trainLandmarkRows.length}`);
    }
  }

  // ===================================================================
  // SECTION 4: LOCKED HOLDOUT EVALUATION (each variant's own best train threshold, applied once)
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 4: LOCKED HOLDOUT EVALUATION — each variant's own train-selected threshold, applied ONCE, no further tuning");
  console.log("-".repeat(118));
  const holdoutRows = evaluated.filter((e) => e.fixture.split === "holdout");
  for (const variant of PIPELINE_VARIANTS) {
    const thresholds = bestThresholdsByVariant[variant];
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const e of holdoutRows) {
      const predicted = passVariant(e.byVariant[variant], thresholds);
      const expected = e.fixture.expectedShouldDetect;
      if (expected && predicted) tp += 1; else if (!expected && predicted) fp += 1; else if (!expected && !predicted) tn += 1; else fn += 1;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    const f1 = 2 * (precision * recall) / Math.max(1e-9, precision + recall);
    console.log(`  ${variant.padEnd(10)} tp=${tp} fp=${fp} tn=${tn} fn=${fn} precision=${fmt(precision)} recall=${fmt(recall)} f1=${fmt(f1)}`);
  }

  // ===================================================================
  // SECTION 5: FAILURE TAXONOMY (at each variant's own locked threshold, across ALL splits)
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 5: FAILURE TAXONOMY (all splits, each variant's own locked threshold)");
  console.log("-".repeat(118));
  for (const variant of PIPELINE_VARIANTS) {
    const thresholds = bestThresholdsByVariant[variant];
    const tally = new Map<string, number>();
    for (const e of evaluated) {
      const predicted = passVariant(e.byVariant[variant], thresholds);
      if (predicted === e.fixture.expectedShouldDetect) continue;
      const cause = classifyFailure({ expectedShouldDetect: e.fixture.expectedShouldDetect, predicted, evaluation: e.byVariant[variant], thresholds });
      tally.set(cause, (tally.get(cause) ?? 0) + 1);
    }
    if (tally.size === 0) { console.log(`  ${variant.padEnd(10)} no failures`); continue; }
    console.log(`  ${variant.padEnd(10)} ${[...tally.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  // ===================================================================
  // SECTION 6: PARTIAL-COPY DEEP DIVE
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 6: PARTIAL-COPY DEEP DIVE (~35.8% case, multi-block, one-long, several-medium — full diagnostic dump)");
  console.log("-".repeat(118));
  for (const id of ["landmark-partial-copy", "landmark-multi-block", "multi-block-query-0", "appended-one-long-block", "appended-many-short-blocks"]) {
    const e = evaluated.find((x) => x.fixture.id === id);
    if (!e) continue;
    console.log(`\n  ${id} (label=${e.fixture.evaluationLabel}, source=${e.fixture.source}):`);
    for (const variant of PIPELINE_VARIANTS) {
      const ev = e.byVariant[variant];
      console.log(`    ${variant.padEnd(10)} containment=${fmt(ev.containment)} matched=${String(ev.matchedWordCount).padStart(4)} longest=${String(ev.longestMatchWords).padStart(4)} passages=${ev.passageCount} density=${fmt(ev.passageDensity)} distinctiveness=${ev.distinctiveness === null ? "n/a" : fmt(ev.distinctiveness)}`);
    }
  }

  // ===================================================================
  // SECTION 7: GENERIC-TEXT SIZE SWEEP (100/150/200/250/300/500+ words)
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 7: GENERIC-TEXT SIZE SWEEP (100/150/200/250/300/500 words, vs MASTER_GENERIC_DOCUMENT — E8N-appended, reported separately)");
  console.log("-".repeat(118));
  const genericSizeFixtures = [100, 150, 200, 250, 300, 500].map((n) => ({
    id: `appended-generic-${n}`,
    text: MASTER_GENERIC_DOCUMENT.trim().split(/\s+/).slice(0, n).join(" "),
    candidateText: MASTER_GENERIC_DOCUMENT,
  }));
  for (const f of genericSizeFixtures) {
    console.log(`  ${f.id.padEnd(24)} words=${tokens(f.text).length}`);
    for (const variant of PIPELINE_VARIANTS) {
      const ev = evaluateVariant(variant, f.text, f.candidateText, { freqIndex: dataset.freqIndex, localCorpusContext: dataset.corpus.map((d) => ({ id: d.id, canonicalText: d.canonicalText })) });
      const passDefault = passVariant(ev);
      const passTuned = passVariant(ev, bestThresholdsByVariant[variant]);
      console.log(`    ${variant.padEnd(10)} matched=${ev.matchedWordCount} distinctiveness=${ev.distinctiveness === null ? "n/a" : fmt(ev.distinctiveness)} pass@default=${passDefault} pass@tuned=${passTuned}`);
    }
  }

  // ===================================================================
  // SECTION 8: ADVERSARIAL DEEP DIVE
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 8: ADVERSARIAL DEEP DIVE — does E8M recover correspondence while V2 still recognizes distinctiveness?");
  console.log("-".repeat(118));
  for (const e of evaluated.filter((x) => x.fixture.evaluationLabel === "ADVERSARIAL_GENERIC" || x.fixture.evaluationLabel === "ADVERSARIAL_DISTINCTIVE")) {
    console.log(`\n  ${e.fixture.id} (${e.fixture.evaluationLabel}, expected=${e.fixture.expectedShouldDetect ? "reuse" : "generic"}):`);
    for (const variant of PIPELINE_VARIANTS) {
      const ev = e.byVariant[variant];
      const passTuned = passVariant(ev, bestThresholdsByVariant[variant]);
      const correct = passTuned === e.fixture.expectedShouldDetect;
      console.log(`    ${variant.padEnd(10)} matched=${String(ev.matchedWordCount).padStart(4)} longest=${String(ev.longestMatchWords).padStart(4)} distinctiveness=${ev.distinctiveness === null ? "n/a  " : fmt(ev.distinctiveness)} pass@tuned=${String(passTuned).padEnd(5)} ${correct ? "ok" : "WRONG"}`);
    }
  }

  // ===================================================================
  // SECTION 9: FEATURE ATTRIBUTION (V2 succeeds where V1 fails, same correspondence engine)
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 9: FEATURE ATTRIBUTION — cases where V2 correctly separates but V1 does not (same correspondence engine)");
  console.log("-".repeat(118));
  for (const [v1Variant, v2Variant] of [["C_V0_V1", "D_V0_V2"], ["E_E8M_V1", "F_E8M_V2"]] as const) {
    for (const e of evaluated) {
      const v1Pass = passVariant(e.byVariant[v1Variant], bestThresholdsByVariant[v1Variant]);
      const v2Pass = passVariant(e.byVariant[v2Variant], bestThresholdsByVariant[v2Variant]);
      const v1Correct = v1Pass === e.fixture.expectedShouldDetect;
      const v2Correct = v2Pass === e.fixture.expectedShouldDetect;
      if (v2Correct && !v1Correct) {
        const { features } = v2DistinctivenessFromCorrespondence(e.fixture.text, e.fixture.candidateText, e.byVariant[v2Variant], dataset.freqIndex);
        console.log(`  ${e.fixture.id} (${v1Variant} wrong -> ${v2Variant} correct): corpusFreq=${fmt(features.corpusFrequency)} rareMultiword=${fmt(features.rareMultiword)} tokenIdf=${fmt(features.tokenIdf)} entity=${fmt(features.entitySignal)} numeric=${fmt(features.numericSignal)} contiguity=${fmt(features.contiguity)} repetition=${fmt(features.internalRepetition)}`);
      }
    }
  }

  // ===================================================================
  // SECTION 10: GENERALIZATION STRESS TEST
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 10: GENERALIZATION STRESS TEST (perturbation battery on 2 DISTINCTIVE_COPY train fixtures)");
  console.log("-".repeat(118));
  const battery = buildPerturbationBattery(dataset);
  console.log(`${battery.length} perturbed variants generated`);
  const degradationByKind = new Map<string, { A: number; B: number }[]>();
  for (const p of battery) {
    const evA = evaluateVariant("A_V0_ONLY", p.text, p.candidateText, { freqIndex: dataset.freqIndex, localCorpusContext: [] });
    const evB = evaluateVariant("B_E8M_ONLY", p.text, p.candidateText, { freqIndex: dataset.freqIndex, localCorpusContext: [] });
    const list = degradationByKind.get(p.kind) ?? [];
    list.push({ A: evA.matchedWordCount, B: evB.matchedWordCount });
    degradationByKind.set(p.kind, list);
  }
  for (const [kind, entries] of degradationByKind) {
    const avgA = entries.reduce((s, e) => s + e.A, 0) / entries.length;
    const avgB = entries.reduce((s, e) => s + e.B, 0) / entries.length;
    console.log(`  ${kind.padEnd(16)} avg V0 matched=${fmt(avgA, 1)}  avg E8M matched=${fmt(avgB, 1)}  ${avgB > avgA ? "E8M recovers more" : avgB === avgA ? "tied" : "V0 recovers more"}`);
  }

  // ===================================================================
  // SECTION 11: PASSAGE QUALITY (localization + no-leakage spot checks)
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 11: PASSAGE QUALITY — localization + no-leakage spot check on landmark-partial-copy");
  console.log("-".repeat(118));
  {
    const e = evaluated.find((x) => x.fixture.id === "landmark-partial-copy")!;
    const copiedZoneWordCount = tokens(e.fixture.text).length; // whole PARTIAL_COPY_DOCUMENT is [copied][filler] per E8J construction
    for (const variant of ["A_V0_ONLY", "B_E8M_ONLY"] as const) {
      const ev = e.byVariant[variant];
      for (const p of ev.passages) {
        const fromCurrentDoc = tokens(e.fixture.text).slice(p.submittedWordStart, p.submittedWordEnd + 1).join(" ") === p.submittedText;
        console.log(`  ${variant} passage [${p.submittedWordStart}-${p.submittedWordEnd}]: reconstructed-from-current-doc=${fromCurrentDoc}, bounded(<=60 words)=${p.submittedText.split(" ").length <= 60}`);
      }
    }
    void copiedZoneWordCount;
  }

  console.log("\n" + "=".repeat(118));
  console.log("REPORT PART 1-11 COMPLETE — see Section 12 (performance) below.");
  console.log("=".repeat(118));

  // ===================================================================
  // SECTION 12: PERFORMANCE (disposable local DB — indexed candidate generation + all 4 stages)
  // ===================================================================
  console.log("\n" + "-".repeat(118));
  console.log("SECTION 12: PERFORMANCE — indexed candidate generation + V0/E8M/V1/V2 stages at scale");
  console.log("-".repeat(118));
  const dbFile = path.join(process.cwd(), "e8n-calibration-local.db");
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ } }
  const client: Client = createClient({ url: `file:${dbFile}` });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));

    const realCandidateText = dataset.fixtures.find((f) => f.underlyingLabel === "DISTINCTIVE_COPY")!.candidateText;
    const canonicalReal = canonicalizeText(realCandidateText);
    const realRep = await createReusableDocumentRepresentation(client, { canonicalText: canonicalReal });
    await recordCorpusShingles(client, realRep.id, canonicalReal);

    let noiseIndex = 0;
    const targets = [100, 300, 1000, 5000, 10000];
    for (const targetTotal of targets) {
      const startPopulate = performance.now();
      const currentCount = Number((await client.execute("SELECT COUNT(*) AS n FROM corpus_document_representations")).rows[0].n);
      const toAdd = Math.max(0, targetTotal - currentCount);
      if (toAdd > 2000) {
        console.log(`  [skipping population to ${targetTotal}: would require ${toAdd} more inserts — reporting the practical limit reached below instead]`);
        break;
      }
      for (let i = 0; i < toAdd; i += 1) {
        const canonicalText = canonicalizeText(noiseIndex % 2 === 0 ? generateGenericDocument(97000 + noiseIndex, 12) : generateDistinctiveDocument(97000 + noiseIndex, 10));
        noiseIndex += 1;
        const rep = await createReusableDocumentRepresentation(client, { canonicalText });
        await recordCorpusShingles(client, rep.id, canonicalText);
      }
      const populateMs = performance.now() - startPopulate;
      const countAfter = Number((await client.execute("SELECT COUNT(*) AS n FROM corpus_document_representations")).rows[0].n);

      const query = tokens(realCandidateText).slice(0, 30).join(" ");
      const candidateStart = performance.now();
      const queryShingles = corpusShingleHashes(query);
      const candidates = await findCandidateCorpusRepresentations(client, queryShingles, { minSharedShingles: 3, limit: 10 });
      const candidateMs = performance.now() - candidateStart;

      let v0Ms = 0, e8mMs = 0, v1Ms = 0, v2Ms = 0, evaluatedCount = 0;
      for (const candidate of candidates) {
        const rep = await findRepresentationById(client, candidate.representationId);
        if (!rep) continue;
        evaluatedCount += 1;
        let t = performance.now();
        computeDocumentCorrespondence(query, rep.canonicalText, DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS);
        v0Ms += performance.now() - t;
        t = performance.now();
        const e8mResult = computeRobustCorrespondence(query, rep.canonicalText);
        e8mMs += performance.now() - t;
        t = performance.now();
        v1DistinctivenessFromCorrespondence(query, rep.canonicalText, e8mResult, []);
        v1Ms += performance.now() - t;
        t = performance.now();
        v2DistinctivenessFromCorrespondence(query, rep.canonicalText, e8mResult, dataset.freqIndex);
        v2Ms += performance.now() - t;
      }
      console.log(`  corpus size ${countAfter} (populate=${fmt(populateMs, 0)}ms): candidate=${fmt(candidateMs, 2)}ms (${candidates.length} candidates) | V0=${fmt(v0Ms, 2)}ms E8M=${fmt(e8mMs, 2)}ms V1=${fmt(v1Ms, 2)}ms V2=${fmt(v2Ms, 2)}ms (n=${evaluatedCount}) | total=${fmt(candidateMs + v0Ms + e8mMs + v1Ms + v2Ms, 2)}ms`);
    }
  } finally {
    client.close();
    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ } }
  }

  console.log("\n" + "=".repeat(118));
  console.log("REPORT COMPLETE.");
  console.log("=".repeat(118));
}

main().catch((err) => {
  console.error("e8n-large-calibration failed:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
