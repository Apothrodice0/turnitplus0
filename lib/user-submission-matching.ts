import type { Client } from "@libsql/client";
import { tokens } from "./similarity-core";
import { canonicalSha256 } from "./document-identity";
import {
  corpusShingleHashes,
  findCandidateCorpusRepresentations,
  findReusableRepresentationByCanonicalHash,
  findRepresentationById,
  summarizeSubmissionOwnership,
  CORPUS_FINGERPRINT_VERSION,
  type CandidateCorpusRepresentation,
} from "./user-submission-corpus";
import {
  computeDocumentCorrespondence,
  type DocumentCorrespondenceThresholds,
  type CorrespondencePassage,
} from "./document-correspondence";

/**
 * Phase E8B: live matching against the E8A user submission history corpus.
 * Storage/indexing only ends here — this is the first module that actually
 * compares a new submission against the reusable corpus and classifies a
 * relationship. Not wired into POST /api/reports, not wired into report
 * scoring or rendering, no public HTTP route — see this phase's own task
 * description, sections 21-23, and tests/user-submission-matching-privacy.test.mjs's
 * structural checks (matching every prior phase's own convention).
 *
 * Two-phase architecture, both phases reusing existing primitives rather
 * than inventing new ones (this phase's own task description, section 6):
 *   1. Candidate generation: lib/user-submission-corpus.ts's
 *      findCandidateCorpusRepresentations, an indexed shingle-hash lookup —
 *      never a scan of every stored representation.
 *   2. Local passage comparison: lib/document-correspondence.ts's
 *      computeDocumentCorrespondence (Phase E6C), completely unmodified,
 *      given this phase's own USER_SUBMISSION_MATCH_THRESHOLDS instead of
 *      E6C's own DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS or any
 *      production scoring threshold.
 *
 * Privacy property this module relies on rather than re-implements:
 * computeDocumentCorrespondence's passages are reconstructed from the FIRST
 * argument's own words only (see that file's header comment) — this module
 * always passes the CURRENT submission's own canonical text as that first
 * argument, so every passage returned is an excerpt of the current user's
 * own document, never of the historical one. No historical document text
 * ever appears anywhere in this module's output.
 *
 * Account-safety is structural (this phase's own task description, section
 * 15): the only function anywhere that looks at which accounts submitted a
 * representation is lib/user-submission-corpus.ts's
 * summarizeSubmissionOwnership, and its own return type has no room for an
 * account id — only a boolean and a count. This module never queries
 * document_identities.account_id, users, or emails directly.
 */

/** Reuses lib/document-family.ts's FamilyMatchType vocabulary values deliberately (this phase's own task description, section 12) — not imported directly, since family membership and corpus-match evidence are different concerns that happen to share the same two meaningful values; SEED does not apply here. */
export type UserSubmissionMatchType = "EXACT_CANONICAL_MATCH" | "STRONG_TEXT_MATCH";

export type RelationshipType = "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP";

export type UserSubmissionMatchConfig = {
  /** Passed straight through to computeDocumentCorrespondence — deliberately its own values, not copied from E6C's DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS or any production scoring threshold (this phase's own task description, section 7). */
  correspondence: DocumentCorrespondenceThresholds;
  /** Coarse candidate-generation filter — how many shared indexed shingles before a representation is even worth loading and locally comparing. Deliberately looser than the correspondence thresholds above, which do the real meaningful-overlap decision. */
  candidateShingleThreshold: number;
  maxCandidates: number;
  /** Which corpus_document_shingles generation to query — see lib/user-submission-corpus.ts's own fingerprint_version comment. */
  fingerprintVersion: string;
  /** This service's own algorithm/config identifier, independent of canonicalizationVersion and fingerprintVersion (this phase's own task description, section 30). */
  matcherVersion: string;
};

/**
 * A starting point for testing/development, not a calibrated or permanent
 * product decision — same disclaimer as every other default thresholds
 * config in this project since Phase B. strongContainmentThreshold is
 * deliberately lower than E6C's 0.6: two independent submissions of "the
 * same" underlying paper (revisions, resubmissions, group members'
 * individually-edited copies) plausibly diverge more than a submission
 * compared against its own published source does.
 */
export const USER_SUBMISSION_MATCHER_VERSION = "user-submission-match-v1";

export const USER_SUBMISSION_MATCH_THRESHOLDS: UserSubmissionMatchConfig = {
  correspondence: {
    shingleSize: 5,
    strongContainmentThreshold: 0.5,
    minimumMatchedWords: 15,
    minimumPassageLengthWords: 8,
    maxPassages: 10,
    maxPassageWords: 60,
  },
  candidateShingleThreshold: 3,
  maxCandidates: 10,
  fingerprintVersion: CORPUS_FINGERPRINT_VERSION,
  matcherVersion: USER_SUBMISSION_MATCHER_VERSION,
};

export type EvidenceVersion = {
  canonicalizationVersion: string;
  fingerprintVersion: string;
  matcherVersion: string;
};

export type UserSubmissionMatch = {
  relationshipType: RelationshipType;
  matchedRepresentationId: string;
  matchType: UserSubmissionMatchType;
  containment: number;
  matchedWordCount: number;
  passageCount: number;
  longestMatchWords: number;
  /** Bounded excerpts of the CURRENT submission's own text only — never the historical document's text. See this file's own header comment. */
  passages: CorrespondencePassage[];
  /** How many OTHER accounts (never which ones) have also submitted this representation, excluding the current submission itself. */
  historicalSubmissionCount: number;
  evidenceVersion: EvidenceVersion;
};

export type UserSubmissionMatchResult =
  | { status: "NO_HISTORICAL_MATCH" }
  | { status: "MATCHED"; matches: UserSubmissionMatch[] };

function mergeConfig(overrides?: Partial<UserSubmissionMatchConfig>): UserSubmissionMatchConfig {
  if (!overrides) return USER_SUBMISSION_MATCH_THRESHOLDS;
  return {
    ...USER_SUBMISSION_MATCH_THRESHOLDS,
    ...overrides,
    correspondence: { ...USER_SUBMISSION_MATCH_THRESHOLDS.correspondence, ...(overrides.correspondence ?? {}) },
  };
}

// Section 18: exact match first, then strongest containment, then largest
// matched word count, then a stable tiebreak on representation id — never
// insertion order, which would be nondeterministic across candidate-set
// construction paths (shingle search vs the defensive exact-hash addition
// below).
function compareMatches(a: UserSubmissionMatch, b: UserSubmissionMatch): number {
  const aExact = a.matchType === "EXACT_CANONICAL_MATCH" ? 1 : 0;
  const bExact = b.matchType === "EXACT_CANONICAL_MATCH" ? 1 : 0;
  if (aExact !== bExact) return bExact - aExact;
  if (a.containment !== b.containment) return b.containment - a.containment;
  if (a.matchedWordCount !== b.matchedWordCount) return b.matchedWordCount - a.matchedWordCount;
  return a.matchedRepresentationId < b.matchedRepresentationId ? -1 : a.matchedRepresentationId > b.matchedRepresentationId ? 1 : 0;
}

/**
 * Compares one new submission's canonical text against the reusable user
 * submission corpus and returns bounded, privacy-safe historical-match
 * evidence. Never writes anything (read-only across corpus_document_
 * representations, corpus_submission_references, corpus_document_shingles,
 * and document_identities — the last only through summarizeSubmissionOwnership's
 * own bounded query). Never touches document_families/document_family_members
 * (this phase's own task description, section 13) and never imports
 * lib/document-family.ts's resolveFamilyForIdentity.
 *
 * accountId=null (this phase's own task description, section 5): no
 * SELF/PRIOR_SUBMISSION distinction is possible without a stable account,
 * so any candidate that clears the correspondence threshold is reported as
 * UNKNOWN_RELATIONSHIP — never guessed as SELF, never silently upgraded to
 * PRIOR_SUBMISSION.
 *
 * documentIdentityId, if given, excludes that one submission's own
 * corpus_submission_references row from ownership counting (via
 * summarizeSubmissionOwnership's excludeDocumentIdentityId) — relevant only
 * if the caller already indexed this exact submission into the corpus
 * before calling this function; harmless to omit otherwise.
 */
export async function matchAgainstUserSubmissionCorpus(
  client: Client,
  params: {
    accountId: string | null;
    documentIdentityId?: string | null;
    canonicalText: string;
    config?: Partial<UserSubmissionMatchConfig>;
  },
): Promise<UserSubmissionMatchResult> {
  const config = mergeConfig(params.config);

  const queryWordCount = tokens(params.canonicalText).length;
  if (queryWordCount === 0) return { status: "NO_HISTORICAL_MATCH" };

  const queryShingles = corpusShingleHashes(params.canonicalText, config.correspondence.shingleSize);

  const shingleCandidates = await findCandidateCorpusRepresentations(client, queryShingles, {
    fingerprintVersion: config.fingerprintVersion,
    minSharedShingles: config.candidateShingleThreshold,
    limit: config.maxCandidates,
  });

  // Defensive guarantee for exact/formatting-only duplicates (sections
  // 10/11): an identical canonical text always has identical shingles and
  // would ordinarily be found by the search above anyway, but a very short
  // document could have fewer shingles than candidateShingleThreshold —
  // this makes the exact-duplicate case correct regardless of that knob.
  const candidateById = new Map<string, CandidateCorpusRepresentation>(shingleCandidates.map((c) => [c.representationId, c]));
  const exactHash = canonicalSha256(params.canonicalText);
  const exactRepresentation = await findReusableRepresentationByCanonicalHash(client, exactHash);
  if (exactRepresentation && !candidateById.has(exactRepresentation.id)) {
    candidateById.set(exactRepresentation.id, {
      representationId: exactRepresentation.id,
      canonicalSha256: exactRepresentation.canonicalSha256,
      wordCount: exactRepresentation.wordCount,
      sharedShingleCount: queryShingles.size,
      containment: 1,
    });
  }

  const boundedCandidates = [...candidateById.values()].slice(0, config.maxCandidates);
  const matches: UserSubmissionMatch[] = [];

  for (const candidate of boundedCandidates) {
    const representation = await findRepresentationById(client, candidate.representationId);
    if (!representation) continue; // defensive: representation was removed between the two queries

    const correspondence = computeDocumentCorrespondence(params.canonicalText, representation.canonicalText, config.correspondence);
    // Section 19/20: textual evidence is required — title/author alone,
    // and weak/common-phrase overlap alone, never produce a match here.
    if (!correspondence.exactCanonicalMatch && !correspondence.strongCorrespondence) continue;

    const ownership = await summarizeSubmissionOwnership(client, representation.id, {
      accountId: params.accountId,
      excludeDocumentIdentityId: params.documentIdentityId ?? null,
    });

    // Phase E8D: once a caller excludes the current submission's own
    // just-indexed reference (documentIdentityId), a representation whose
    // ONLY submitter was that excluded reference now correctly shows no
    // ownership at all — this is not "no relationship," it is "nothing to
    // report a relationship against," since the sole evidence was the
    // current submission matching itself. Before E8D this was unreachable
    // (nothing was ever indexed before its own report was first viewed);
    // now that save-time indexing is live, a signed-in account's very
    // first-ever upload of new content would otherwise be misreported as
    // PRIOR_SUBMISSION against no one. Drop it exactly like NO_HISTORICAL_MATCH.
    if (params.accountId !== null && !ownership.hasSameAccountSubmission && ownership.otherAccountSubmissionCount === 0) continue;

    let relationshipType: RelationshipType;
    if (params.accountId === null) {
      relationshipType = "UNKNOWN_RELATIONSHIP";
    } else if (ownership.hasSameAccountSubmission) {
      relationshipType = "SELF";
    } else {
      relationshipType = "PRIOR_SUBMISSION";
    }

    matches.push({
      relationshipType,
      matchedRepresentationId: representation.id,
      matchType: correspondence.exactCanonicalMatch ? "EXACT_CANONICAL_MATCH" : "STRONG_TEXT_MATCH",
      containment: correspondence.containment,
      matchedWordCount: correspondence.matchedWordCount,
      passageCount: correspondence.passages.length,
      longestMatchWords: correspondence.longestMatchWords,
      passages: correspondence.passages,
      historicalSubmissionCount: ownership.otherAccountSubmissionCount,
      evidenceVersion: {
        canonicalizationVersion: representation.canonicalizationVersion,
        fingerprintVersion: config.fingerprintVersion,
        matcherVersion: config.matcherVersion,
      },
    });
  }

  if (matches.length === 0) return { status: "NO_HISTORICAL_MATCH" };

  matches.sort(compareMatches);
  return { status: "MATCHED", matches };
}
