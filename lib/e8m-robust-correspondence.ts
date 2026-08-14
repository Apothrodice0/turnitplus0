import { tokens, COMMON_WORDS } from "./similarity-core";

/**
 * Phase E8M: an experimental, pure, edit-tolerant correspondence engine —
 * completely independent of lib/document-correspondence.ts (the "V0"
 * baseline, never imported here, never modified) and of
 * lib/user-submission-matching.ts (never imported here). No DB, no I/O.
 *
 * WHY V0 struggles with small edits (worked example, verified by hand
 * before writing this file): V0's matching unit is a single, exact 5-word
 * shingle, looked up in a position-independent SET. A one-word insertion
 * breaks every 5-word window that overlaps the insertion point — up to
 * shingleSize-1 words on each side — and, critically, if the remaining
 * unbroken run on either side of a disruption is SHORTER than shingleSize
 * (very common right at a sentence's tail), that run can never form a
 * complete shingle at all, no matter how verbatim it is. For
 * "The Meridian system increased fulfillment accuracy, rising from 81% to
 * 94%." (one word, "rising", inserted before "from"), V0 loses "from 81 to
 * 94" entirely — four verbatim words with nowhere left to attach a 5-word
 * window. This is a structural property of fixed-width exact shingles, not
 * a tuning problem solvable by changing shingleSize globally (a smaller
 * shingle size everywhere would just trade this failure for more
 * generic-text false positives — see this file's own calibration report).
 *
 * DESIGN CHOSEN (justified by the report's guardrail/gap/anchor sweeps —
 * see tools/e8m-correspondence-calibration.ts): approach C+D from this
 * phase's own task description — "anchored distinctive spans followed by
 * bounded local extension" / "edit-tolerant alignment around
 * high-information anchors". Concretely:
 *
 *   1. ANCHOR DETECTION: find short (ANCHOR_SIZE-word, smaller than V0's
 *      shingle size) windows in the submitted text whose exact content also
 *      appears in the external text — but only windows meeting a STRICTER
 *      informativeness bar than V0's own informativeGram() (a higher
 *      fraction of the anchor's words must be long/uncommon, scaled by
 *      anchor size) — a smaller window is inherently more likely to recur
 *      by coincidence, so it needs more distinctiveness density to be
 *      trusted as a seed at all. This is NOT "lower the shingle size":
 *      shrinking the window is only safe because it is paired with a
 *      tightened informativeness requirement, and it only ever SEEDS a
 *      match — it never decides containment by itself.
 *   2. BOUNDED LOCAL EXTENSION: from each confirmed anchor, walk outward
 *      word-by-word in both directions, confirming continuation via a
 *      small (CONFIRM_WINDOW-word) lookahead against the external text —
 *      this lookahead is NOT informativeness-filtered (once a distinctive
 *      anchor has established real correspondence, its immediate
 *      surroundings are trusted more loosely, the same way a human reader
 *      would keep reading past "rising" once they recognize the sentence).
 *      Up to GAP_TOLERANCE consecutive unconfirmed words are tolerated
 *      before extension in that direction stops; the final span ends at
 *      the last word that was actually reconfirmed, so a gap that never
 *      resolves back into real correspondence is never credited.
 *   3. Overlapping/adjacent extended spans are merged, filtered by a
 *      minimum length, and turned into bounded passages reconstructed from
 *      the CURRENT submission's own words only (same privacy property as
 *      lib/document-correspondence.ts's own passages).
 *
 * Never claims a plagiarism probability — every score here is a bounded,
 * relative correspondence measure for calibration purposes only.
 */

export const ROBUST_CORRESPONDENCE_VERSION = "e8m-v1";

export type RobustCorrespondenceConfig = {
  anchorSize: number;
  confirmWindow: number;
  gapTolerance: number;
  minimumSpanLengthWords: number;
  maxPassages: number;
  maxPassageWords: number;
};

export const DEFAULT_ROBUST_CORRESPONDENCE_CONFIG: RobustCorrespondenceConfig = {
  anchorSize: 4,
  confirmWindow: 2,
  gapTolerance: 3,
  minimumSpanLengthWords: 6,
  maxPassages: 10,
  maxPassageWords: 60,
};

export type RobustPassage = {
  submittedText: string;
  submittedWordStart: number;
  submittedWordEnd: number;
  externalWordStart: null;
  matchedWordCount: number;
};

export type RobustCorrespondenceResult = {
  version: typeof ROBUST_CORRESPONDENCE_VERSION;
  matchedWordCount: number;
  passageCount: number;
  longestMatchWords: number;
  /** shared informative anchors / min(submitted, external) anchor count — the same normalization shape as lib/similarity-core.ts's containment(), applied to this engine's own anchor unit instead of a 5-word shingle. */
  containment: number;
  /** matchedWordCount / envelope span of all accepted passages — how tightly the matched words cluster, same definition E8K/E8L already use. */
  passageDensity: number;
  submittedWordCount: number;
  externalWordCount: number;
  passages: RobustPassage[];
  config: RobustCorrespondenceConfig;
};

function localContainment(shared: number, a: number, b: number): number {
  return shared / Math.max(1, Math.min(a, b));
}

function isInformativeWord(word: string): boolean {
  return word.length >= 4 && !COMMON_WORDS.has(word);
}

/** Stricter than lib/similarity-core.ts's informativeGram (2-of-5 = 40%) — scales with anchor size so a shorter, inherently less-specific window needs a HIGHER informative-word density to be trusted as a seed. */
function isInformativeAnchor(words: string[]): boolean {
  const required = Math.ceil(words.length * 0.75);
  return words.filter(isInformativeWord).length >= required;
}

function joinGram(words: string[], start: number, size: number): string {
  return words.slice(start, start + size).join(" ");
}

function buildGramSet(words: string[], size: number, requireInformative: boolean): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) {
    if (requireInformative && !isInformativeAnchor(words.slice(i, i + size))) continue;
    set.add(joinGram(words, i, size));
  }
  return set;
}

type Span = { start: number; end: number };

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 1) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Extends outward from a confirmed anchor [seedStart, seedEnd] (inclusive
 * submitted-word positions), tolerating up to gapTolerance consecutive
 * unconfirmed confirmWindow-word lookaheads before stopping in that
 * direction. Bounded: each direction visits at most submittedWords.length
 * positions once.
 */
function extendFromAnchor(
  submittedWords: string[],
  seedStart: number,
  seedEnd: number,
  externalConfirmGrams: Set<string>,
  config: RobustCorrespondenceConfig,
): Span {
  const { confirmWindow, gapTolerance } = config;

  let end = seedEnd;
  {
    let gapCount = 0;
    let cursor = seedEnd + 1;
    let lastConfirmed = seedEnd;
    while (cursor + confirmWindow - 1 < submittedWords.length) {
      const window = joinGram(submittedWords, cursor, confirmWindow);
      if (externalConfirmGrams.has(window)) {
        lastConfirmed = cursor + confirmWindow - 1;
        gapCount = 0;
      } else {
        gapCount += 1;
        if (gapCount > gapTolerance) break;
      }
      cursor += 1;
    }
    end = lastConfirmed;
  }

  let start = seedStart;
  {
    let gapCount = 0;
    let cursor = seedStart - confirmWindow;
    let lastConfirmed = seedStart;
    while (cursor >= 0) {
      const window = joinGram(submittedWords, cursor, confirmWindow);
      if (externalConfirmGrams.has(window)) {
        lastConfirmed = cursor;
        gapCount = 0;
      } else {
        gapCount += 1;
        if (gapCount > gapTolerance) break;
      }
      cursor -= 1;
    }
    start = lastConfirmed;
  }

  return { start, end };
}

/**
 * The engine's single entry point. Pure and deterministic. Order of
 * operations mirrors lib/document-correspondence.ts's own structure
 * (tokenize both sides, find anchors, extend, merge, reconstruct bounded
 * passages) without sharing any code with it.
 */
export function computeRobustCorrespondence(
  submittedText: string,
  externalText: string,
  config: RobustCorrespondenceConfig = DEFAULT_ROBUST_CORRESPONDENCE_CONFIG,
): RobustCorrespondenceResult {
  const submittedWords = tokens(submittedText);
  const externalWords = tokens(externalText);

  if (submittedWords.length === 0 || externalWords.length === 0) {
    return {
      version: ROBUST_CORRESPONDENCE_VERSION, matchedWordCount: 0, passageCount: 0, longestMatchWords: 0,
      containment: 0, passageDensity: 0, submittedWordCount: submittedWords.length, externalWordCount: externalWords.length,
      passages: [], config,
    };
  }

  const externalAnchorGrams = buildGramSet(externalWords, config.anchorSize, true);
  const externalConfirmGrams = buildGramSet(externalWords, config.confirmWindow, false);
  const submittedAnchorGrams = buildGramSet(submittedWords, config.anchorSize, true);

  let sharedAnchorCount = 0;
  for (const gram of submittedAnchorGrams) if (externalAnchorGrams.has(gram)) sharedAnchorCount += 1;

  // Seed positions: every submitted-text window whose content is a
  // confirmed, informative anchor. Positions already covered by a
  // previously extended span are skipped — bounds total work to O(N) spans
  // instead of O(N) redundant re-extensions from every overlapping seed.
  const rawSpans: Span[] = [];
  let coveredUpTo = -1;
  for (let i = 0; i + config.anchorSize <= submittedWords.length; i += 1) {
    if (i + config.anchorSize - 1 <= coveredUpTo) continue;
    const window = joinGram(submittedWords, i, config.anchorSize);
    if (!externalAnchorGrams.has(window)) continue;
    const span = extendFromAnchor(submittedWords, i, i + config.anchorSize - 1, externalConfirmGrams, config);
    rawSpans.push(span);
    coveredUpTo = Math.max(coveredUpTo, span.end);
  }

  const merged = mergeSpans(rawSpans).filter((s) => s.end - s.start + 1 >= config.minimumSpanLengthWords);

  const passages: RobustPassage[] = merged
    .map((s): RobustPassage => {
      const words = submittedWords.slice(s.start, Math.min(s.end + 1, s.start + config.maxPassageWords));
      return { submittedText: words.join(" "), submittedWordStart: s.start, submittedWordEnd: s.end, externalWordStart: null, matchedWordCount: s.end - s.start + 1 };
    })
    .sort((a, b) => b.matchedWordCount - a.matchedWordCount)
    .slice(0, config.maxPassages);

  const matchedWordCount = merged.reduce((sum, s) => sum + (s.end - s.start + 1), 0);
  const longestMatchWords = merged.reduce((max, s) => Math.max(max, s.end - s.start + 1), 0);

  let passageDensity = 0;
  if (merged.length > 0) {
    const envelopeStart = Math.min(...merged.map((s) => s.start));
    const envelopeEnd = Math.max(...merged.map((s) => s.end));
    passageDensity = matchedWordCount / Math.max(1, envelopeEnd - envelopeStart + 1);
  }

  return {
    version: ROBUST_CORRESPONDENCE_VERSION,
    matchedWordCount,
    passageCount: merged.length,
    longestMatchWords,
    containment: localContainment(sharedAnchorCount, submittedAnchorGrams.size, externalAnchorGrams.size),
    passageDensity,
    submittedWordCount: submittedWords.length,
    externalWordCount: externalWords.length,
    passages,
    config,
  };
}
