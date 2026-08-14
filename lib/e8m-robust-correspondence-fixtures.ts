import { tokens } from "./similarity-core";
import {
  E8J_BASE_DOCUMENT,
  SAME_TOPIC_DOCUMENT as SAME_TOPIC_DIFFERENT_WORDING_DOCUMENT,
  GENERIC_100, GENERIC_200, GENERIC_300,
} from "./e8k-calibration-fixtures";
import { PARTIAL_COPY_DOCUMENT } from "./e8j-calibration-fixtures";
import { generateGenericDocument } from "./e8l-calibration-corpus";

/**
 * Phase E8M: fixtures for the experimental edit-tolerant correspondence
 * engine. Every base sentence/passage here is invented for this phase or
 * directly reused from E8J/E8K/E8L's own already-reviewed synthetic content
 * (never real archive material, never a real user document). No DB, no I/O.
 */

// --- section 5: the exact worked example from this phase's own task description ---

export const PRIMARY_ORIGINAL_SENTENCE = "The Meridian system increased fulfillment accuracy from 81% to 94%.";
export const PRIMARY_VARIANT_A_COMMA_INSERTION = "The Meridian system increased fulfillment accuracy, rising from 81% to 94%.";
export const PRIMARY_VARIANT_B_SENTENCE_SPLIT = "The Meridian system increased fulfillment accuracy. It rose from 81% to 94%.";
export const PRIMARY_VARIANT_C_MODIFIERS = "The Meridian system materially increased fulfillment accuracy from approximately 81% to 94%.";

// --- explicit sentence-merge counterpart to the split test above -------------------

export const MERGE_ORIGINAL_TWO_SENTENCES = "The Meridian system increased fulfillment accuracy. The improvement was documented across all regional warehouses.";
export const MERGE_VARIANT_MERGED = "The Meridian system increased fulfillment accuracy, and the improvement was documented across all regional warehouses.";

// --- section 6: punctuation-only variants of a longer base passage -----------------

export const PUNCTUATION_BASE_PASSAGE =
  "The Fernbridge water treatment facility processed an average of 4.2 million gallons per day during the quarter, a figure that exceeded the previous year's average by nearly eleven percent. Engineers attributed the increase to a combination of population growth in the service area and the completion of a new intake line that had been delayed since 2022. The facility's chief operator noted that filtration costs rose only modestly despite the higher volume, a result she credited to the membrane upgrade completed the previous spring.";

export const PUNCTUATION_VARIANTS: Record<string, string> = {
  commaRemoval: PUNCTUATION_BASE_PASSAGE.replace(/,/g, ""),
  semicolonSubstitution: PUNCTUATION_BASE_PASSAGE.replace(/\. /g, "; "),
  parentheses: PUNCTUATION_BASE_PASSAGE.replace("nearly eleven percent", "(nearly eleven percent)"),
  colonInsertion: PUNCTUATION_BASE_PASSAGE.replace("The facility's chief operator noted", "The facility's chief operator noted:"),
  hyphenation: PUNCTUATION_BASE_PASSAGE.replace("water treatment facility", "water-treatment facility").replace("membrane upgrade", "membrane-upgrade"),
  quoteChanges: PUNCTUATION_BASE_PASSAGE.replace("chief operator", "“chief operator”"),
  lineBreaks: PUNCTUATION_BASE_PASSAGE.replace(/\. /g, ".\n\n"),
};

// --- sections 7/8: insertion / deletion / substitution sweeps at a longer base ------

export const INS_DEL_BASE_PASSAGE =
  "Regional planners completed the annual transit ridership survey in early March, drawing responses from just over six thousand commuters across the metropolitan service area. The survey found that weekday ridership on the light rail line had climbed steadily since the fare restructuring introduced two years earlier, while bus ridership remained essentially flat over the same period. Planners noted that the light rail gains were concentrated almost entirely on the eastern corridor, where three new stations opened during the survey window, and cautioned against generalizing the finding to the system as a whole without further study of the western corridor's slower recovery.";

const FILLER_WORDS = ["notably", "essentially", "particularly", "generally", "specifically", "additionally", "further", "quite", "rather", "indeed"];
const SUBSTITUTE_PAIRS: Array<[string, string]> = [
  ["completed", "finished"], ["survey", "study"], ["climbed", "risen"], ["steadily", "consistently"],
  ["remained", "stayed"], ["concentrated", "clustered"], ["opened", "launched"], ["cautioned", "warned"],
  ["generalizing", "extrapolating"], ["recovery", "rebound"],
];

function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/);
}

/** Inserts n filler words at evenly-spaced positions across the base passage — deterministic, no randomness. */
export function insertWords(base: string, n: number): string {
  const words = wordsOf(base);
  if (n <= 0) return base;
  const step = Math.max(1, Math.floor(words.length / (n + 1)));
  const result = [...words];
  for (let i = n; i >= 1; i -= 1) {
    const pos = Math.min(result.length, i * step);
    result.splice(pos, 0, FILLER_WORDS[i % FILLER_WORDS.length]);
  }
  return result.join(" ");
}

/** Deletes n words at evenly-spaced positions — deterministic. */
export function deleteWords(base: string, n: number): string {
  const words = wordsOf(base);
  if (n <= 0) return base;
  const step = Math.max(1, Math.floor(words.length / (n + 1)));
  const positionsToDelete = new Set<number>();
  for (let i = 1; i <= n; i += 1) positionsToDelete.add(Math.min(words.length - 1, i * step));
  return words.filter((_, idx) => !positionsToDelete.has(idx)).join(" ");
}

/** Substitutes n words (from SUBSTITUTE_PAIRS, applied in order) with a controlled synonym — surrounding text is otherwise untouched. */
export function substituteWords(base: string, n: number): string {
  let result = base;
  for (let i = 0; i < Math.min(n, SUBSTITUTE_PAIRS.length); i += 1) {
    const [from, to] = SUBSTITUTE_PAIRS[i];
    result = result.replace(from, to);
  }
  return result;
}

// --- section 9: light paraphrase (deterministic, no LLM) ---------------------------

const PARAPHRASE_SUBSTITUTIONS: Array<[string, string]> = [
  ["completed the annual transit ridership survey", "finished the yearly transit ridership study"],
  ["drawing responses from just over six thousand commuters", "gathering replies from slightly more than six thousand riders"],
  ["climbed steadily since the fare restructuring", "risen consistently following the fare restructuring"],
  ["remained essentially flat over the same period", "stayed largely unchanged across that same span"],
];

export const LIGHT_PARAPHRASE_VARIANT = PARAPHRASE_SUBSTITUTIONS.reduce((text, [from, to]) => text.replace(from, to), INS_DEL_BASE_PASSAGE);

// --- section 13: distinctive anchors, then restructured around them -----------------

export const DISTINCTIVE_ANCHOR_ORIGINAL =
  "The Solenne-7 calibration unit, developed by Fairweather Instruments, recorded a deviation of 218.4 microamps during the third test cycle, well outside the tolerance band established in the original specification. Dr. Priya Anand flagged the deviation to the review board on the same afternoon, noting that two prior units from the same production batch had shown similar readings.";

export const DISTINCTIVE_ANCHOR_RESTRUCTURED =
  "During the third test cycle, the Solenne-7 calibration unit — a Fairweather Instruments product — ended up recording a deviation, and that deviation came in at 218.4 microamps, landing it well outside the tolerance band the original specification had established. That same afternoon, it was Dr. Priya Anand who flagged the deviation for the review board, and she also pointed out that two prior units from that identical production batch had turned up similar readings of their own.";

// --- section 11: generic boilerplate --------------------------------------------------

export const GENERIC_LONG_METHODOLOGY_BLOCK = generateGenericDocument(95000, 40);
export const GENERIC_REPEATED_BOILERPLATE = new Array(6).fill("The results of this study indicate that further research is needed in this area.").join(" ");

// --- reused directly from E8J -----------------------------------------------------------

export { E8J_BASE_DOCUMENT, PARTIAL_COPY_DOCUMENT, SAME_TOPIC_DIFFERENT_WORDING_DOCUMENT, GENERIC_100, GENERIC_200, GENERIC_300 };

// --- fixture registry for the calibration report/tests -------------------------------

export type E8MFixtureCategory =
  | "PUNCTUATION" | "INSERTION" | "DELETION" | "SUBSTITUTION" | "PARAPHRASE"
  | "SENTENCE_SPLIT_MERGE" | "PARTIAL_COPY" | "GENERIC" | "SAME_TOPIC" | "DISTINCTIVE_ANCHOR";

export type E8MFixture = {
  id: string;
  category: E8MFixtureCategory;
  text: string;
  candidateText: string;
  expected: "COPIED" | "GENERIC" | "INDEPENDENT";
};

export const E8M_FIXTURES: E8MFixture[] = [
  { id: "primary-original-self", category: "SENTENCE_SPLIT_MERGE", text: PRIMARY_ORIGINAL_SENTENCE, candidateText: PRIMARY_ORIGINAL_SENTENCE, expected: "COPIED" },
  { id: "primary-comma-insertion", category: "SENTENCE_SPLIT_MERGE", text: PRIMARY_VARIANT_A_COMMA_INSERTION, candidateText: PRIMARY_ORIGINAL_SENTENCE, expected: "COPIED" },
  { id: "primary-sentence-split", category: "SENTENCE_SPLIT_MERGE", text: PRIMARY_VARIANT_B_SENTENCE_SPLIT, candidateText: PRIMARY_ORIGINAL_SENTENCE, expected: "COPIED" },
  { id: "primary-modifiers", category: "SENTENCE_SPLIT_MERGE", text: PRIMARY_VARIANT_C_MODIFIERS, candidateText: PRIMARY_ORIGINAL_SENTENCE, expected: "COPIED" },
  { id: "primary-sentence-merge", category: "SENTENCE_SPLIT_MERGE", text: MERGE_VARIANT_MERGED, candidateText: MERGE_ORIGINAL_TWO_SENTENCES, expected: "COPIED" },

  ...Object.entries(PUNCTUATION_VARIANTS).map(([name, text]) => ({
    id: `punctuation-${name}`, category: "PUNCTUATION" as const, text, candidateText: PUNCTUATION_BASE_PASSAGE, expected: "COPIED" as const,
  })),

  ...[1, 3, 5, 10].map((n) => ({ id: `insertion-${n}`, category: "INSERTION" as const, text: insertWords(INS_DEL_BASE_PASSAGE, n), candidateText: INS_DEL_BASE_PASSAGE, expected: "COPIED" as const })),
  ...[1, 3, 5, 10].map((n) => ({ id: `deletion-${n}`, category: "DELETION" as const, text: deleteWords(INS_DEL_BASE_PASSAGE, n), candidateText: INS_DEL_BASE_PASSAGE, expected: "COPIED" as const })),
  ...[1, 3, 5, 10].map((n) => ({ id: `substitution-${n}`, category: "SUBSTITUTION" as const, text: substituteWords(INS_DEL_BASE_PASSAGE, n), candidateText: INS_DEL_BASE_PASSAGE, expected: "COPIED" as const })),

  { id: "light-paraphrase", category: "PARAPHRASE", text: LIGHT_PARAPHRASE_VARIANT, candidateText: INS_DEL_BASE_PASSAGE, expected: "COPIED" },

  { id: "partial-copy", category: "PARTIAL_COPY", text: PARTIAL_COPY_DOCUMENT, candidateText: E8J_BASE_DOCUMENT, expected: "COPIED" },

  { id: "generic-100", category: "GENERIC", text: GENERIC_100, candidateText: E8J_BASE_DOCUMENT, expected: "GENERIC" },
  { id: "generic-200", category: "GENERIC", text: GENERIC_200, candidateText: E8J_BASE_DOCUMENT, expected: "GENERIC" },
  { id: "generic-300", category: "GENERIC", text: GENERIC_300, candidateText: E8J_BASE_DOCUMENT, expected: "GENERIC" },
  { id: "generic-long-methodology", category: "GENERIC", text: GENERIC_LONG_METHODOLOGY_BLOCK, candidateText: E8J_BASE_DOCUMENT, expected: "GENERIC" },
  { id: "generic-repeated-boilerplate", category: "GENERIC", text: GENERIC_REPEATED_BOILERPLATE, candidateText: E8J_BASE_DOCUMENT, expected: "GENERIC" },

  { id: "same-topic", category: "SAME_TOPIC", text: SAME_TOPIC_DIFFERENT_WORDING_DOCUMENT, candidateText: E8J_BASE_DOCUMENT, expected: "INDEPENDENT" },

  { id: "distinctive-anchor-restructured", category: "DISTINCTIVE_ANCHOR", text: DISTINCTIVE_ANCHOR_RESTRUCTURED, candidateText: DISTINCTIVE_ANCHOR_ORIGINAL, expected: "COPIED" },
];

export function wordCount(text: string): number {
  return tokens(text).length;
}
