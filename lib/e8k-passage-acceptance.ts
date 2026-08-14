import type { PassageLevelDiagnostics } from "./e8k-passage-evaluator";

/**
 * Phase E8K: an explicit, experimental passage-level acceptance rule —
 * deliberately its own module, its own config, its own name, so it can
 * never be confused with or accidentally wired into
 * lib/user-submission-matching.ts's USER_SUBMISSION_MATCH_THRESHOLDS. Never
 * imported by, and never imports, the production matcher. This is a
 * prototype for calibration only — see this phase's own task description,
 * section 17: "Do NOT reuse or mutate production thresholds."
 */

export type PassageLevelExperimentalThresholds = {
  minimumMatchedWords: number;
  minimumLongestPassageWords: number;
  minimumPassageDensity: number;
  minimumInformativeSharedShingles: number;
  minimumMeaningfulPassages: number;
  /**
   * Not part of this phase's own mandated 3-dimension sweep (section 18
   * lists only matched-words/longest-passage/density) — added so the
   * false-positive investigation into generic text (section 12/14) has a
   * concrete lever to test, since distinctiveness was built specifically to
   * address that case. Defaults to 0 (off) so the primary, spec-mandated
   * sweep is unaffected unless a caller explicitly opts in.
   */
  minimumDistinctiveness: number;
};

/**
 * A starting point for experimentation, not a calibrated or permanent
 * product decision — same disclaimer as every other default-thresholds
 * config in this project. Chosen only to be "a reasonable middle of the
 * sweep range this phase's own task description lists in section 18," nothing more.
 */
export const PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS: PassageLevelExperimentalThresholds = {
  minimumMatchedWords: 150,
  minimumLongestPassageWords: 100,
  minimumPassageDensity: 0.10,
  minimumInformativeSharedShingles: 15,
  minimumMeaningfulPassages: 1,
  minimumDistinctiveness: 0,
};

export type AcceptanceCheck = { code: string; ok: boolean; detail: string };
export type ExperimentalAcceptanceResult = { pass: boolean; checks: AcceptanceCheck[] };

/**
 * Pure rule evaluation — no I/O, no production import. An unambiguous exact
 * (or formatting-only) canonical match always passes, independent of every
 * numeric threshold below — this phase's own task description (sections
 * 5/6) is explicit that "the passage path must not disagree with the
 * obvious exact match," and an exact match is strictly stronger evidence
 * than any passage-level heuristic this experimental rule could apply to it.
 */
export function evaluateExperimentalAcceptance(
  diagnostics: PassageLevelDiagnostics,
  thresholds: PassageLevelExperimentalThresholds = PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS,
): ExperimentalAcceptanceResult {
  if (diagnostics.isExactCanonicalMatch) {
    return { pass: true, checks: [{ code: "EXACT_CANONICAL_MATCH", ok: true, detail: "whole-text canonical hash match — passes unconditionally, independent of every numeric threshold below" }] };
  }
  const checks: AcceptanceCheck[] = [
    { code: "MATCHED_WORDS", ok: diagnostics.matchedWordCount >= thresholds.minimumMatchedWords, detail: `${diagnostics.matchedWordCount} >= ${thresholds.minimumMatchedWords}` },
    { code: "LONGEST_PASSAGE", ok: diagnostics.longestMatchWords >= thresholds.minimumLongestPassageWords, detail: `${diagnostics.longestMatchWords} >= ${thresholds.minimumLongestPassageWords}` },
    { code: "PASSAGE_DENSITY", ok: diagnostics.passageDensity >= thresholds.minimumPassageDensity, detail: `${diagnostics.passageDensity.toFixed(3)} >= ${thresholds.minimumPassageDensity}` },
    { code: "INFORMATIVE_SHINGLES", ok: diagnostics.informativeSharedShingleCount >= thresholds.minimumInformativeSharedShingles, detail: `${diagnostics.informativeSharedShingleCount} >= ${thresholds.minimumInformativeSharedShingles}` },
    { code: "MEANINGFUL_PASSAGES", ok: diagnostics.passageCount >= thresholds.minimumMeaningfulPassages, detail: `${diagnostics.passageCount} >= ${thresholds.minimumMeaningfulPassages}` },
    { code: "DISTINCTIVENESS", ok: diagnostics.distinctiveness >= thresholds.minimumDistinctiveness, detail: `${diagnostics.distinctiveness.toFixed(3)} >= ${thresholds.minimumDistinctiveness}` },
  ];
  return { pass: checks.every((c) => c.ok), checks };
}

export type SweepFixtureInput = { category: string; diagnostics: PassageLevelDiagnostics; expectedShouldDetect: boolean };
export type SweepPointResult = {
  thresholds: PassageLevelExperimentalThresholds;
  perFixture: { category: string; pass: boolean; expectedShouldDetect: boolean; correct: boolean }[];
  correctCount: number;
  totalCount: number;
  allCorrect: boolean;
};

/**
 * Runs evaluateExperimentalAcceptance across every combination of the
 * supplied threshold option lists, against every fixture's already-computed
 * diagnostics (computed once, swept many times — no recomputation of
 * shingles/passages per sweep point). density/shingle/passage-count
 * thresholds are held at PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS's own
 * defaults for dimensions not being swept, unless overridden.
 */
export function sweepThresholds(
  fixtures: SweepFixtureInput[],
  options: {
    minimumMatchedWordsOptions: number[];
    minimumLongestPassageWordsOptions: number[];
    minimumPassageDensityOptions: number[];
    /** Not part of the spec-mandated 3-dimension sweep — defaults to [0] (a single, no-op value) so passing nothing reproduces exactly that sweep. */
    minimumDistinctivenessOptions?: number[];
    base?: PassageLevelExperimentalThresholds;
  },
): SweepPointResult[] {
  const base = options.base ?? PASSAGE_LEVEL_EXPERIMENTAL_THRESHOLDS;
  const distinctivenessOptions = options.minimumDistinctivenessOptions ?? [0];
  const results: SweepPointResult[] = [];
  for (const minimumMatchedWords of options.minimumMatchedWordsOptions) {
    for (const minimumLongestPassageWords of options.minimumLongestPassageWordsOptions) {
      for (const minimumPassageDensity of options.minimumPassageDensityOptions) {
        for (const minimumDistinctiveness of distinctivenessOptions) {
          const thresholds: PassageLevelExperimentalThresholds = { ...base, minimumMatchedWords, minimumLongestPassageWords, minimumPassageDensity, minimumDistinctiveness };
          const perFixture = fixtures.map((f) => {
            const { pass } = evaluateExperimentalAcceptance(f.diagnostics, thresholds);
            return { category: f.category, pass, expectedShouldDetect: f.expectedShouldDetect, correct: pass === f.expectedShouldDetect };
          });
          const correctCount = perFixture.filter((p) => p.correct).length;
          results.push({ thresholds, perFixture, correctCount, totalCount: perFixture.length, allCorrect: correctCount === perFixture.length });
        }
      }
    }
  }
  return results;
}
