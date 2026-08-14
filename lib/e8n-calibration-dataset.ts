import {
  buildBackgroundCorpus, buildQueryFixtures, type CorpusDocument, type QueryFixture, type QueryLabel,
} from "./e8l-calibration-corpus";
import { buildCorpusFrequencyIndex, type CorpusFrequencyIndex } from "./e8l-distinctiveness-v2";
import { ONE_LONG_DISTINCTIVE_OVERLAP, MANY_SHORT_COMMON_OVERLAPS, HIST_DISTINCTIVE_DOCUMENT, HIST_GENERIC_DOCUMENT } from "./e8k-calibration-fixtures";
import { insertWords, deleteWords, substituteWords } from "./e8m-robust-correspondence-fixtures";

/**
 * Phase E8N: dataset assembly. Reuses lib/e8l-calibration-corpus.ts's
 * buildBackgroundCorpus() and buildQueryFixtures() completely unmodified —
 * same 116-document corpus, same construction, same train/holdout/landmark
 * split (see this phase's own task description, section 2: "do NOT
 * silently regenerate it into a materially different dataset"). Everything
 * in this file is either (a) a thin relabeling wrapper for reporting
 * purposes only — the underlying E8L fixture objects are never mutated —
 * or (b) explicitly new, separately-reported fixtures appended on top.
 */

export type E8NLabel = QueryLabel | "ADVERSARIAL_GENERIC" | "ADVERSARIAL_DISTINCTIVE";

export type E8NFixture = {
  id: string;
  evaluationLabel: E8NLabel;
  underlyingLabel: QueryLabel;
  text: string;
  candidateText: string;
  split: "train" | "holdout" | "landmark" | "appended";
  expectedShouldDetect: boolean;
  source: "E8L" | "E8N_APPENDED";
};

const REUSE_LABELS: QueryLabel[] = ["DISTINCTIVE_COPY", "LIGHT_REUSE", "MODERATE_REUSE", "HEAVY_REUSE", "PARTIAL_COPY", "MULTI_BLOCK_COPY"];
function expectedShouldDetect(label: QueryLabel): boolean {
  return REUSE_LABELS.includes(label);
}

export type E8NDataset = {
  corpus: CorpusDocument[];
  freqIndex: CorpusFrequencyIndex;
  fixtures: E8NFixture[];
  appendedFixtures: E8NFixture[];
};

export function buildE8NDataset(): E8NDataset {
  const corpus = buildBackgroundCorpus();
  const freqIndex = buildCorpusFrequencyIndex(corpus);
  const { fixtures: e8lFixtures, adversarialGeneric, adversarialDistinctive } = buildQueryFixtures(corpus);

  const fixtures: E8NFixture[] = [
    ...e8lFixtures.map((f): E8NFixture => ({
      id: f.id, evaluationLabel: f.label, underlyingLabel: f.label, text: f.text, candidateText: f.candidateText,
      split: f.split, expectedShouldDetect: expectedShouldDetect(f.label), source: "E8L",
    })),
    ...adversarialGeneric.map((f): E8NFixture => ({
      id: f.id, evaluationLabel: "ADVERSARIAL_GENERIC", underlyingLabel: f.label, text: f.text, candidateText: f.candidateText,
      split: f.split, expectedShouldDetect: false, source: "E8L",
    })),
    ...adversarialDistinctive.map((f): E8NFixture => ({
      id: f.id, evaluationLabel: "ADVERSARIAL_DISTINCTIVE", underlyingLabel: f.label, text: f.text, candidateText: f.candidateText,
      split: f.split, expectedShouldDetect: true, source: "E8L",
    })),
  ];

  // --- appended (section 10: "one long copied block" / "multiple short copied blocks") ---
  const appendedFixtures: E8NFixture[] = [
    {
      id: "appended-one-long-block", evaluationLabel: "PARTIAL_COPY", underlyingLabel: "PARTIAL_COPY",
      text: ONE_LONG_DISTINCTIVE_OVERLAP, candidateText: HIST_DISTINCTIVE_DOCUMENT,
      split: "appended", expectedShouldDetect: true, source: "E8N_APPENDED",
    },
    {
      id: "appended-many-short-blocks", evaluationLabel: "COMMON_BOILERPLATE", underlyingLabel: "COMMON_BOILERPLATE",
      text: MANY_SHORT_COMMON_OVERLAPS, candidateText: HIST_GENERIC_DOCUMENT,
      split: "appended", expectedShouldDetect: false, source: "E8N_APPENDED",
    },
  ];

  return { corpus, freqIndex, fixtures, appendedFixtures };
}

// --- generalization stress (section 19) ------------------------------------------

export type PerturbationKind =
  | "SENTENCE_SPLIT" | "SENTENCE_MERGE" | "INSERT_1" | "INSERT_3" | "INSERT_5" | "INSERT_10"
  | "DELETE_1" | "DELETE_3" | "DELETE_5" | "DELETE_10" | "SUBSTITUTE_1" | "SUBSTITUTE_3" | "SUBSTITUTE_5" | "SUBSTITUTE_10"
  | "PUNCTUATION_ONLY" | "ENTITY_CHANGE" | "NUMBER_CHANGE";

export type PerturbedFixture = { id: string; kind: PerturbationKind; sourceFixtureId: string; text: string; candidateText: string };

function splitFirstSentence(text: string): string {
  const idx = text.indexOf(". ");
  if (idx === -1) return text;
  return `${text.slice(0, idx)}.\n\n${text.slice(idx + 2)}`;
}
function mergeFirstTwoSentences(text: string): string {
  return text.replace(". ", ", and ");
}
function punctuationOnly(text: string): string {
  return text.replace(/,/g, ";").replace(/\. /g, ".\n");
}
function entityChange(text: string, from: string, to: string): string {
  return text.split(from).join(to);
}
function numberChange(text: string): string {
  return text.replace(/\b\d+(\.\d+)?\b/, (m) => String(Number(m) + 7));
}

/**
 * Applies the full section-19 perturbation battery to a small, explicit
 * subset of existing DISTINCTIVE_COPY fixtures — reuses
 * lib/e8m-robust-correspondence-fixtures.ts's own insertWords/deleteWords/
 * substituteWords helpers unchanged (same deterministic, position-based
 * transforms E8M's own fixtures already use) rather than inventing new
 * perturbation logic.
 */
export function buildPerturbationBattery(dataset: E8NDataset): PerturbedFixture[] {
  const sourceFixtures = dataset.fixtures.filter((f) => f.underlyingLabel === "DISTINCTIVE_COPY" && f.split === "train").slice(0, 2);
  const battery: PerturbedFixture[] = [];
  for (const source of sourceFixtures) {
    const base = source.text; // a near-exact copy of source.candidateText — perturbing it directly
    battery.push({ id: `${source.id}-split`, kind: "SENTENCE_SPLIT", sourceFixtureId: source.id, text: splitFirstSentence(base), candidateText: source.candidateText });
    battery.push({ id: `${source.id}-merge`, kind: "SENTENCE_MERGE", sourceFixtureId: source.id, text: mergeFirstTwoSentences(base), candidateText: source.candidateText });
    for (const n of [1, 3, 5, 10]) {
      battery.push({ id: `${source.id}-insert-${n}`, kind: `INSERT_${n}` as PerturbationKind, sourceFixtureId: source.id, text: insertWords(base, n), candidateText: source.candidateText });
      battery.push({ id: `${source.id}-delete-${n}`, kind: `DELETE_${n}` as PerturbationKind, sourceFixtureId: source.id, text: deleteWords(base, n), candidateText: source.candidateText });
      battery.push({ id: `${source.id}-substitute-${n}`, kind: `SUBSTITUTE_${n}` as PerturbationKind, sourceFixtureId: source.id, text: substituteWords(base, n), candidateText: source.candidateText });
    }
    battery.push({ id: `${source.id}-punctuation`, kind: "PUNCTUATION_ONLY", sourceFixtureId: source.id, text: punctuationOnly(base), candidateText: source.candidateText });
    battery.push({ id: `${source.id}-entity-change`, kind: "ENTITY_CHANGE", sourceFixtureId: source.id, text: entityChange(base, "Meridian Analytics", "Solstice Retail Group"), candidateText: source.candidateText });
    battery.push({ id: `${source.id}-number-change`, kind: "NUMBER_CHANGE", sourceFixtureId: source.id, text: numberChange(base), candidateText: source.candidateText });
  }
  return battery;
}
