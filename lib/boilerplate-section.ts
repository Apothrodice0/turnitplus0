import { findReferenceSectionStart } from "./reference-section";

/**
 * Metadata-relevance investigation (K-drama/RECYT/BayesValidRox offline
 * experiment) ISSUE A: a submission's own administrative boilerplate —
 * competing-interest declarations, acknowledgments, funding/financial
 * disclosures — pollutes its topic-term profile with generic academic-
 * paper-structure vocabulary ("financial", "interests", "declare",
 * "authors", "grant", "funded"). That vocabulary then spuriously matches
 * OTHER papers' own boilerplate sections (or, worse, OpenAIRE index
 * records whose own metadata title happens to BE a boilerplate sentence —
 * a real, confirmed case: several indexed records are literally titled
 * "The Authors Declare that They Have No Known Competing Financial
 * Interests..."), rewarding candidates for shared document STRUCTURE
 * rather than shared TOPIC. Confirmed live against the real BayesValidRox
 * PDF's own extracted text (see this module's own tests): its
 * "Acknowledgment"/"Competing Interests" paragraphs, immediately preceding
 * its reference list, are exactly this pattern.
 *
 * General, phrase-shape-based detection — deliberately NOT a list of
 * document-specific phrases (see this investigation's own explicit
 * requirement not to hardcode anything BayesValidRox-specific). Mirrors
 * lib/reference-section.ts's own established approach: match a heading
 * keyword/phrase, then require the text immediately following it to
 * corroborate that this is really a declaration section and not an
 * ordinary-prose mention of the same word (e.g. "multiple competing
 * models," confirmed as a real false-positive risk in the same BayesValidRox
 * PDF; "government funding for social programs" is an equally realistic
 * risk for an economics submission like RECYT). Same PDF/DOCX-format-
 * agnostic reasoning applies: PDF extraction does not reliably preserve
 * paragraph breaks (see reference-section.ts's own header comment), so
 * this never depends on newline structure.
 *
 * Unlike a reference section (one heading, strip everything after it to
 * the end of the document), boilerplate sections are short, self-contained
 * paragraphs that can appear anywhere near a document's end, sometimes
 * several in a row — so this returns a list of bounded EXCISION spans
 * (heading through a bounded lookahead, capped by the next detected
 * heading of any kind), not a single "strip from here to the end" cut
 * point.
 */

export type BoilerplateCategory = "competing-interest" | "acknowledgment" | "funding";

export type BoilerplateSection = {
  start: number;
  end: number;
  category: BoilerplateCategory;
};

/**
 * "Competing interests"/"conflict(s) of interest"/"declaration of
 * interest" as an exact multi-word phrase is rare in ordinary prose
 * compared to the bare word "competing" alone (see this module's own
 * header comment on "multiple competing models") — but still needs the
 * sentence-boundary check below (startsAfterSentenceBoundary), the same as
 * the other two categories: a realistic submission could genuinely discuss
 * "the competing interests of stakeholders in policy negotiations" as its
 * own subject matter (a real risk for an economics/policy document), and
 * that usage sits mid-sentence, not at a section-opening boundary.
 */
const COMPETING_INTEREST_HEADING = /\b(?:competing|conflicts?)\s+(?:of\s+)?interests?\b|\bdeclarations?\s+of\s+(?:competing\s+)?interests?\b/gi;

/** Generic enough ("we acknowledge that...") to require corroboration — see ACKNOWLEDGMENT_COROBORATION below. */
const ACKNOWLEDGMENT_HEADING = /\backnowledge?ments?\b/gi;

/** "Funding" alone is the riskiest of the three (plausible as genuine subject matter in, e.g., an economics or policy paper) — always requires corroboration. */
const FUNDING_HEADING = /\bfunding\b|\bfinancial\s+(?:support|disclosure)\b|\bgrant\s+support\b/gi;

const COROBORATION_WINDOW = 180;

function hasNearbyVocabulary(text: string, matchEnd: number, vocabulary: RegExp): boolean {
  const nearby = text.slice(matchEnd, matchEnd + COROBORATION_WINDOW);
  return vocabulary.test(nearby);
}

const ACKNOWLEDGMENT_COROBORATION = /\b(thank\w*|grateful|appreciat\w*|support\w*|fund\w*|would\s+like\s+to)\b/i;
const FUNDING_COROBORATION = /\b(received?|grant\w*|support\w*|sponsor\w*|provided\s+by|fund\w*|declar\w*|authors?)\b/i;

/**
 * Required for every category, not just vocabulary corroboration: a real
 * section heading opens a fresh sentence/paragraph, immediately after the
 * previous section's own closing punctuation (or document start) — never
 * embedded mid-sentence. This is what actually distinguishes a genuine
 * "Funding" heading from ordinary prose that happens to use the word
 * ("Additional funding was received from...", confirmed as a real false
 * positive against the real BayesValidRox text otherwise — see this
 * module's own tests): the word "funding" there is preceded by "Additional
 * " with no sentence boundary in between, not by a period. Nearby-
 * vocabulary corroboration alone is not enough on its own, because ordinary
 * declarative funding/acknowledgment PROSE naturally contains the exact
 * same vocabulary as a heading's own opening sentence would.
 */
function startsAfterSentenceBoundary(text: string, matchStart: number): boolean {
  const before = text.slice(0, matchStart);
  return before.trimEnd() === "" || /[.!?]["')\]]?\s*$/.test(before);
}

/**
 * When no other heading (another boilerplate category, or a reference
 * section) is found nearby to bound the excision, this is the fallback:
 * the end of the FIRST complete sentence after the heading, searched
 * within this window. A flat character cap was tried first and rejected —
 * it swallowed real trailing content whenever no second heading happened
 * to follow within range (confirmed by this module's own tests: a short
 * "Acknowledgments ... Conclusion ..." fixture had its own real
 * Conclusion sentence deleted because nothing stopped the cap from running
 * through it). Stopping at the first sentence boundary is deliberately
 * conservative — a genuine two-sentence declaration paragraph not
 * followed by another detected heading will only have its first sentence
 * excised, which is the same conservative-under-match tradeoff
 * reference-section.ts's own false-positive guards already accept
 * elsewhere in this codebase.
 */
const SENTENCE_BOUNDARY = /[.!?]["')\]]?(?=\s|$)/;
const FALLBACK_WINDOW = 400;

function findSectionEnd(text: string, headingEnd: number, nextBoundaryCap: number): number {
  const windowEnd = Math.min(headingEnd + FALLBACK_WINDOW, nextBoundaryCap, text.length);
  const window = text.slice(headingEnd, windowEnd);
  const match = SENTENCE_BOUNDARY.exec(window);
  if (match) return headingEnd + match.index + match[0].length;
  return windowEnd;
}

type Candidate = { start: number; end: number; category: BoilerplateCategory; corroborated: boolean };

function findHeadingCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const match of text.matchAll(COMPETING_INTEREST_HEADING)) {
    const start = match.index!;
    candidates.push({ start, end: start + match[0].length, category: "competing-interest", corroborated: startsAfterSentenceBoundary(text, start) });
  }
  for (const match of text.matchAll(ACKNOWLEDGMENT_HEADING)) {
    const start = match.index!;
    const end = start + match[0].length;
    candidates.push({ start, end, category: "acknowledgment", corroborated: startsAfterSentenceBoundary(text, start) && hasNearbyVocabulary(text, end, ACKNOWLEDGMENT_COROBORATION) });
  }
  for (const match of text.matchAll(FUNDING_HEADING)) {
    const start = match.index!;
    const end = start + match[0].length;
    candidates.push({ start, end, category: "funding", corroborated: startsAfterSentenceBoundary(text, start) && hasNearbyVocabulary(text, end, FUNDING_COROBORATION) });
  }
  return candidates.filter((c) => c.corroborated).sort((a, b) => a.start - b.start);
}

/**
 * Returns every detected boilerplate section as a bounded {start, end}
 * span, in document order, non-overlapping. When another detected heading
 * (a different boilerplate category, or a reference section) follows
 * within FALLBACK_WINDOW, that heading IS the boundary — it is already a
 * corroborated, real structural marker, exactly how the real BayesValidRox
 * Acknowledgment/Competing-Interests/References run of three back-to-back
 * headings bounds correctly (see this module's own tests). Otherwise the
 * excision falls back to findSectionEnd's first-sentence-boundary rule, so
 * a lone declaration paragraph with nothing detected after it never
 * swallows unrelated later content.
 */
export function findBoilerplateSections(text: string): BoilerplateSection[] {
  const headingCandidates = findHeadingCandidates(text);
  if (headingCandidates.length === 0) return [];

  const referenceStart = findReferenceSectionStart(text);
  const sections: BoilerplateSection[] = [];

  for (let i = 0; i < headingCandidates.length; i++) {
    const current = headingCandidates[i];
    if (sections.length > 0 && current.start < sections[sections.length - 1].end) continue; // already covered by a preceding section's excision

    const nextHeadingStart = i + 1 < headingCandidates.length ? headingCandidates[i + 1].start : Infinity;
    const boundedByReferences = referenceStart >= 0 && referenceStart > current.start ? referenceStart : Infinity;
    const nextStructuralBoundary = Math.min(nextHeadingStart, boundedByReferences);

    const end = nextStructuralBoundary - current.end <= FALLBACK_WINDOW
      ? Math.min(nextStructuralBoundary, text.length)
      : findSectionEnd(text, current.end, Infinity);

    sections.push({ start: current.start, end, category: current.category });
  }

  return sections;
}

/** The submission text with every detected boilerplate section removed (replaced with a single space, so words on either side of an excised span never get glued together). Returns the input unchanged when no boilerplate section is found. */
export function stripBoilerplateSections(text: string): string {
  const sections = findBoilerplateSections(text);
  if (sections.length === 0) return text;

  let result = "";
  let cursor = 0;
  for (const section of sections) {
    result += text.slice(cursor, section.start) + " ";
    cursor = section.end;
  }
  result += text.slice(cursor);
  return result;
}
