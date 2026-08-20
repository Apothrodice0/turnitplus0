import {
  computeDocumentCorrespondence,
  DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
  type DocumentCorrespondenceThresholds,
} from "../document-correspondence";
import { tokens } from "../similarity-core";
import type { MatchedPassage } from "./types";

/**
 * Stage 7 of the pipeline (local comparison). Deliberately NOT a new
 * similarity algorithm: this is a thin wrapper around
 * lib/document-correspondence.ts's computeDocumentCorrespondence, which is
 * already the project's purpose-built "does this specific retrieved
 * external text correspond to this specific submitted document" engine
 * (Phase E6C) — independently thresholded from report-scoring, exactly the
 * property STEP 6 asks for ("keep this entirely separate from score,
 * archiveScore, aiScore, verifiedSimilarity, historical-match state, E8S").
 * Reusing it here is the "cleanest integration point" for comparison:
 * reimplementing shingle containment a second time would only add a second,
 * competing algorithm with no behavioral benefit.
 */

export type ComparisonResult = {
  /** 0..100, from computeDocumentCorrespondence's containment — "how much of the submission's distinctive content appears in this external source." */
  similarity: number;
  matchedPassages: MatchedPassage[];
  /** lib/document-correspondence.ts's own strongCorrespondence verdict (containment + matched-word floor), passed through unchanged. */
  strongMatch: boolean;
  exactMatch: boolean;
};

/** Same bound lib/document-correspondence.ts's own passage-building already uses (DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.maxPassageWords) — kept in sync manually since the exact-match short-circuit below never reaches that code path to inherit it automatically. */
const EXACT_MATCH_PASSAGE_PREVIEW_WORDS = 60;

/**
 * "Investigate two real detection issues" ISSUE 2: computeDocumentCorrespondence's
 * canonical-hash exact-match short-circuit returns matchedWordCount equal to
 * the full submission (correct) but an EMPTY passages array (its own
 * documented behavior — see that file's own emptyResult() helper and
 * lib/unified-similarity.ts's previousUploadPassageRanges(), which already
 * had to work around the identical gap for the user-submission-matching
 * caller). This comparator is a SECOND, independent caller of the same
 * function that had never received the equivalent fix: a candidate whose
 * retrieved text was byte-for-byte identical to the submission (similarity
 * 100, exactMatch true) still produced matchedPassages: [] here, and
 * lib/unified-similarity.ts's computeUnifiedSimilarity() only ever reads
 * matchedPassages (never the standalone similarity percentage) — so a
 * perfectly confirmed academic match could silently contribute zero to the
 * unified score. Reproduced live against a real bioRxiv preprint,
 * genuinely indexed on OpenAIRE, whose own retrieved full text matched
 * itself exactly.
 *
 * Fixed the same way lib/unified-similarity.ts fixed it for its own
 * caller: synthesize one full-range passage rather than modifying
 * lib/document-correspondence.ts's own documented contract (which other
 * callers may depend on as-is). submittedText is still bounded to a
 * preview-sized excerpt (matching every other passage's own convention —
 * see DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.maxPassageWords) so an
 * exact match on a very large document does not balloon the stored report.
 */
export function compareSubmissionToExternalText(
  submittedText: string,
  externalText: string,
  thresholds: DocumentCorrespondenceThresholds = DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS,
): ComparisonResult {
  const result = computeDocumentCorrespondence(submittedText, externalText, thresholds);
  const matchedPassages: MatchedPassage[] = result.passages.length > 0
    ? result.passages.map((passage) => ({
      submittedText: passage.submittedText,
      submittedWordStart: passage.submittedWordStart,
      submittedWordEnd: passage.submittedWordEnd,
      matchedWordCount: passage.matchedWordCount,
    }))
    : result.exactCanonicalMatch && result.matchedWordCount > 0
      ? [{
        submittedText: tokens(submittedText).slice(0, EXACT_MATCH_PASSAGE_PREVIEW_WORDS).join(" "),
        submittedWordStart: 0,
        submittedWordEnd: result.matchedWordCount - 1,
        matchedWordCount: result.matchedWordCount,
      }]
      : [];
  return {
    similarity: Math.round(result.containment * 100),
    matchedPassages,
    strongMatch: result.strongCorrespondence,
    exactMatch: result.exactCanonicalMatch,
  };
}
