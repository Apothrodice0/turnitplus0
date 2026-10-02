import type { Client } from "@libsql/client";
import { tokens } from "./similarity-core";
import { canonicalSha256 } from "./document-identity";
import {
  corpusShingleHashes,
  findCandidateCorpusRepresentations,
  findReusableRepresentationByCanonicalHash,
  findRepresentationById,
  summarizeSubmissionOwnershipForRepresentations,
  isRepresentationActivelyPromoted,
  isRepresentationEligibleForMatching,
  corpusMaturityCutoff,
  CORPUS_FINGERPRINT_VERSION,
  type CandidateCorpusRepresentation,
  type SubmissionOwnershipSummary,
} from "./user-submission-corpus";
import {
  computeDocumentCorrespondence,
  type DocumentCorrespondenceThresholds,
  type CorrespondencePassage,
} from "./document-correspondence";
import { isCorpusSourceMatchingEnabled } from "./corpus-source-matching-flag";

// Re-exported so existing callers (this file's own tests, lib/report-historical-match.ts)
// can keep importing it from here — the flag itself is defined in its own
// file so that an app/ file needing only this one boolean never has to
// import the matching service itself. See
// lib/corpus-source-matching-flag.ts's own header comment.
export { isCorpusSourceMatchingEnabled };

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
 * 15): the only functions anywhere that look at which accounts submitted a
 * representation are lib/user-submission-corpus.ts's
 * summarizeSubmissionOwnership and its batch form
 * summarizeSubmissionOwnershipForRepresentations, and their return type has
 * no room for an account id — only a boolean and a count. This module never
 * queries document_identities.account_id, users, or emails directly.
 */

/** Reuses lib/document-family.ts's FamilyMatchType vocabulary values deliberately (this phase's own task description, section 12) — not imported directly, since family membership and corpus-match evidence are different concerns that happen to share the same two meaningful values; SEED does not apply here. */
export type UserSubmissionMatchType = "EXACT_CANONICAL_MATCH" | "STRONG_TEXT_MATCH";

/**
 * TURNITPLUS_CORPUS_SOURCE: a candidate with ZERO real submission-reference
 * ownership (summarizeSubmissionOwnership found no account at all — the
 * existing condition that used to mean "drop this candidate for a signed-in
 * account, or report UNKNOWN_RELATIONSHIP for an anonymous one") whose
 * representation IS actively backed by an 'indexed' corpus-admission
 * promotion (CandidateCorpusRepresentation.isActivelyPromoted). Reported the
 * same way regardless of the CURRENT submitter's own account state —
 * anonymous or signed-in, this describes the SOURCE, not the viewer. Gated
 * by isCorpusSourceMatchingEnabled(); SELF/PRIOR_SUBMISSION/
 * UNKNOWN_RELATIONSHIP below are completely unaffected by that flag — see
 * matchAgainstUserSubmissionCorpus's own comment on where exactly this
 * branch sits relative to the pre-existing ones.
 */
export type RelationshipType = "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP" | "TURNITPLUS_CORPUS_SOURCE";

export type UserSubmissionMatchConfig = {
  /** Passed straight through to computeDocumentCorrespondence — deliberately its own values, not copied from E6C's DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS or any production scoring threshold (this phase's own task description, section 7). */
  correspondence: DocumentCorrespondenceThresholds;
  /** Coarse candidate-generation filter — how many shared indexed shingles before a representation is even worth loading and locally comparing. Deliberately looser than the correspondence thresholds above, which do the real meaningful-overlap decision. */
  candidateShingleThreshold: number;
  /**
   * How many candidates that can NEVER score (SELF, UNKNOWN_RELATIONSHIP)
   * are verified and reported, in rank order; the rest are passed over
   * without loading their text. Nothing else:
   *   - it is not a LIMIT on raw discovered rows;
   *   - it does NOT bound scoring candidates (PRIOR_SUBMISSION,
   *     TURNITPLUS_CORPUS_SOURCE). Every one the pass reaches is verified,
   *     and every one that verifies is reported and reaches the union — a
   *     count of verified sources never caps scoring evidence;
   *   - a candidate that would be dropped outright (no real ownership for a
   *     signed-in viewer) is never verified and consumes nothing.
   * See matchAgainstUserSubmissionCorpus's own CANDIDATE BUDGET comment.
   */
  maxCandidates: number;
  /**
   * How many ranked candidate rows one discovery round trip returns —
   * transport batching, NOT a cap on what is examined: a full page is
   * followed by the next one (same total order) until the candidate list is
   * exhausted or a time budget stops the pass. No value of it changes which
   * candidates are examined on a quiet
   * database, only how many round trips that takes. Optional, and
   * deliberately absent from USER_SUBMISSION_MATCH_THRESHOLDS (default
   * USER_SUBMISSION_CANDIDATE_PAGE_SIZE): lib/report-historical-match.ts
   * digests that object into every snapshot's matcher_version tag, and a
   * batching size is not a reason to recompute stored snapshots.
   */
  candidatePageSize?: number;
  /** Which corpus_document_shingles generation to query — see lib/user-submission-corpus.ts's own fingerprint_version comment. */
  fingerprintVersion: string;
  /** This service's own algorithm/config identifier, independent of canonicalizationVersion and fingerprintVersion (this phase's own task description, section 30). */
  matcherVersion: string;
  /**
   * HARD input limit, not a timeout: a candidate representation whose own
   * word_count exceeds this is skipped entirely — computeDocumentCorrespondence
   * is never called on it — before any correspondence work starts. This is
   * the real backstop against a single pathologically large candidate
   * document blowing the per-request time budget below; matchTimeBudgetMs
   * cannot protect against that on its own (see this file's own comment on
   * why a cooperative deadline can only refuse to START new work, never
   * interrupt a single computeDocumentCorrespondence call already running).
   * A scoring candidate skipped by this limit was discovered but never
   * verified, so the result is returned with partial:true.
   */
  maxCandidateWordCount: number;
  /**
   * SOFT, cooperative deadline for the whole matching pass — checked ONLY
   * between candidates in the correspondence loop (and before each further
   * page of candidates is requested), never mid-computation.
   * This can stop the loop from STARTING another candidate once the budget
   * is spent; it cannot cancel, interrupt, or bound a single
   * computeDocumentCorrespondence call already in flight (JS/Node has no
   * built-in way to preempt synchronous CPU work). maxCandidateWordCount
   * above is what actually bounds a single call's own worst case. See
   * matchAgainstUserSubmissionCorpus's own comment for the full honesty
   * disclosure this file's own review explicitly asked for.
   */
  matchTimeBudgetMs: number;
  /**
   * A REAL (not cooperative) timeout, legitimate specifically because this
   * wraps genuinely asynchronous I/O — the findCandidateCorpusRepresentations
   * DB call — where Promise.race can actually abandon a hung/slow query the
   * same way any "give up waiting" pattern does, unlike the synchronous
   * correspondence loop below.
   */
  dbQueryTimeoutMs: number;
  /**
   * 10k+-corpus scale hardening: query-time high-frequency ("maxDF") shingle
   * pruning ceiling for candidate DISCOVERY, passed straight through to
   * findCandidateCorpusRepresentations (see
   * lib/user-submission-corpus.ts's applyHighFrequencyShinglePruning for the
   * full mechanism and the measured rationale). A query 5-gram found in more
   * than this many representations that are MATCH-ELIGIBLE FOR THIS
   * REQUESTER (revoked/deactivated-only representations, and representations
   * backed only by the requester's own admission promotions, do not count —
   * the same account-aware eligibility the candidate query applies) is
   * dropped before the candidate search — it is common register /
   * boilerplate, contributes ~nothing to discovery, and at scale both
   * dominates the candidate query's cost and evicts genuinely distinctive
   * sources from the ranked LIMIT window.
   *
   * DISCOVERY ONLY: every surviving candidate is still re-verified by
   * computeDocumentCorrespondence from full canonical text below, so
   * passages, matchedWordCount, longestMatchWords, the matched-word union
   * and the final unified score are identical to an unpruned run for every
   * candidate that survives — and a candidate only fails to survive if it
   * shares solely common-register shingles, which computeDocumentCorrespondence
   * already refuses to accept as a match. Exact-canonical duplicates are
   * additionally protected by this file's own canonical-hash fallback,
   * independent of DF.
   *
   * null disables pruning entirely (findCandidateCorpusRepresentations then
   * runs the exact query every prior build ran, with no extra DB round
   * trip). The default is a positive integer chosen so that below ~1k
   * representations no real shingle ever reaches it (pruning is inert at
   * today's corpus size) while it engages exactly as the corpus grows into
   * the range where the unpruned query would otherwise time out.
   */
  maxCandidateShingleDocumentFrequency: number | null;
  /**
   * Low-information-query fallback floor, forwarded as
   * findCandidateCorpusRepresentations' minDiscriminativeShingles — only
   * consulted when maxCandidateShingleDocumentFrequency is non-null. If
   * high-DF pruning would leave fewer than this many surviving query
   * shingles (a document written almost entirely in common academic
   * register), pruning is ABANDONED for that query and the complete
   * original query shingle set is searched — exactly what an unpruned run
   * does — so such a document is never turned into a false
   * NO_HISTORICAL_MATCH by pruning alone.
   */
  minDiscriminativeShingles: number;
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
// v2: which candidates are verified and reported changed (v1 cut the ranked
// list at ten rows before classifying them, then at ten verified scoring
// sources). A v1 result can be missing verified sources, so it must not be
// reused: lib/report-historical-match.ts folds this label into every
// snapshot's matcher_version, and a row tagged v1 is recomputed by the next
// write-capable resolution instead of being trusted. USER_SUBMISSION_MATCH_THRESHOLDS
// is unchanged, so the label is the only thing that tells the two apart.
export const USER_SUBMISSION_MATCHER_VERSION = "user-submission-match-v2";

/**
 * Default UserSubmissionMatchConfig.candidatePageSize. One page is one run
 * of the candidate aggregate, whose cost is the posting lists it reads, not
 * the rows it returns — measured ~1.6 s for 200 same-account drafts of a
 * 600-word document whether 10 or 250 rows come back, and a further page
 * pays that again. So the page is sized to hold every realistic candidate
 * list in a single round trip (an author with hundreds of earlier drafts, a
 * cohort sharing a passage): paging is the exception that keeps the pass
 * exhaustive, not the normal path. Rows are five scalar columns each, and
 * the per-candidate total-shingle query is skipped (omitContainment), so a
 * full page costs little beyond the aggregate itself.
 */
export const USER_SUBMISSION_CANDIDATE_PAGE_SIZE = 500;

export const USER_SUBMISSION_MATCH_THRESHOLDS: UserSubmissionMatchConfig = {
  correspondence: {
    shingleSize: 5,
    strongContainmentThreshold: 0.5,
    minimumMatchedWords: 15,
    minimumPassageLengthWords: 8,
    maxPassages: 10,
    maxPassageWords: 60,
    /**
     * Phase 6.6 PART 2: opts this production matcher into
     * lib/document-correspondence.ts's distinctivePassageMatch signal (see
     * that file's own comment for the mechanism, including the generic-
     * academic-register density guardrail) — a confirmed real case (40
     * exact copied words inside a 156-word source, ~25% document-level
     * containment) was silently rejected by strongContainmentThreshold's
     * whole-document gate alone despite being unambiguous verbatim reuse.
     * 30 is chosen to sit with real margin on both sides of the two
     * boundary cases this phase's own task explicitly names: comfortably
     * above "common 10-20 word academic boilerplate" (which must NOT
     * become a match) and comfortably below the real 40-word case that
     * MUST be detected (measured longestMatchWords for that real fixture
     * is 42, not 40 — the shingle-matched span, once informativeGram-
     * filtered edges are included, ran slightly longer than the raw
     * excerpt).
     *
     * Length alone was tried first and found insufficient: a real
     * calibration fixture (tests/e8p-shadow-evaluation.test.mjs's own
     * MANY_SHORT_COMMON_OVERLAPS vs HIST_GENERIC_DOCUMENT case) showed
     * THREE independent short generic academic sentences (14-19 words
     * each) can sit adjacent with no other text between them and merge
     * into one 43-word contiguous span — a length comfortably inside the
     * real 40-42 word case that must pass, so raising the length floor
     * alone cannot separate them. lib/document-correspondence.ts's own
     * GENERIC_ACADEMIC_REGISTER_WORDS density check (a corpus-independent,
     * word-frequency-derived signal, not the corpus-frequency-based
     * distinctiveness model other experimental modules in this codebase
     * use — that model's own length bias and small-corpus reliability
     * concerns are documented on its own source) resolves this: measured
     * density is 0.098-0.125 on every genuine passage available for
     * testing (the real 40-42 word case, several longer real fixtures) vs
     * 0.565-0.625 on generic/concatenated-generic text, comfortable margin
     * on both sides of the 0.4 cutoff. Verified against Phase 6.5's own
     * real false-positive controls (topical similarity, generic
     * boilerplate, genuine paraphrase) plus new boilerplate-length-
     * specific regression cases — see
     * tests/user-submission-matching.test.mjs's own PART 2 section.
     */
    minimumDistinctivePassageWords: 30,
  },
  candidateShingleThreshold: 3,
  maxCandidates: 10,
  fingerprintVersion: CORPUS_FINGERPRINT_VERSION,
  matcherVersion: USER_SUBMISSION_MATCHER_VERSION,
  // A starting point, not calibrated against real corpus-size measurements
  // yet — same disclaimer as every other default above. 20,000 words is
  // comfortably above any known real submission in this product's own
  // upload limits, so this should never trigger on legitimate content; it
  // exists purely as a backstop against a single oversized/degenerate
  // corpus row.
  maxCandidateWordCount: 20_000,
  matchTimeBudgetMs: 2_500,
  dbQueryTimeoutMs: 1_500,
  // 10k+-corpus scale hardening — see maxCandidateShingleDocumentFrequency's
  // own comment on UserSubmissionMatchConfig. 50 was chosen from direct
  // measurement against synthetic corpora at 200 / 2,000 / 8,000+
  // representations with realistic shingle density (work/maxdf, not
  // committed):
  //   - below ~1,000 representations no real 5-gram reaches DF 50, so this
  //     is completely inert at today's corpus size — the only cost is one
  //     extra bounded eligible-DF probe (json_each + per-hash `LIMIT`) per
  //     cold historical-match computation, a few ms on a small corpus, and
  //     nothing is pruned;
  //   - at 8,000 representations (11.8M shingle rows) the unpruned candidate
  //     query takes ~5-9 s (over dbQueryTimeoutMs — the matcher is already
  //     silently timing out at that scale); with maxDF=50 the
  //     eligibility-correct DF probe measured ~0.56 s (worst-case,
  //     corpus-size-independent) plus a small pruned candidate query
  //     complete well under the 1.5 s budget, and a genuinely copied source
  //     ranks #1 instead of being evicted past the LIMIT;
  //   - 50 in a 10k corpus is 0.5% — comfortably above any real
  //     resubmission / revision cluster (nobody resubmits one paper 50
  //     times) and far below true boilerplate DF (hundreds to thousands),
  //     with the minDiscriminativeShingles fallback (bypass-pruning)
  //     covering the mostly-generic-document edge.
  // DF counts representations that are MATCH-ELIGIBLE FOR THIS REQUESTER —
  // the exact account-aware admissionEligibilitySql the candidate query
  // applies: revoked/deactivated-only representations, and representations
  // backed only by the requester's own admission promotion(s), do not
  // inflate it (see applyHighFrequencyShinglePruning).
  // Set to null to disable pruning entirely (exact pre-hardening behavior,
  // no extra query).
  maxCandidateShingleDocumentFrequency: 50,
  minDiscriminativeShingles: 24,
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
  | { status: "NO_HISTORICAL_MATCH"; partial?: boolean }
  | { status: "MATCHED"; matches: UserSubmissionMatch[]; partial?: boolean };

/**
 * Developer/test-only diagnostics for one matching pass. Populated in place
 * when matchAgainstUserSubmissionCorpus is handed a `diagnostics` sink —
 * never part of any return value, never reachable from a similarity report,
 * and carrying no corpus identifiers (counts, durations and one enum), the
 * same discipline as lib/user-submission-corpus.ts's
 * CandidateDiscoveryDiagnostics.
 */
export type UserSubmissionMatchDiagnostics = {
  /** Ranked candidate rows read from discovery across every page (plus the exact-canonical fallback candidate, if it was added), before any relationship is known. */
  rawCandidatesConsidered: number;
  /** Of those, candidates whose relationship can contribute to the score (PRIOR_SUBMISSION, TURNITPLUS_CORPUS_SOURCE). */
  eligibleCandidatesConsidered: number;
  /** computeDocumentCorrespondence calls actually made, for scoring and non-scoring candidates alike. */
  candidatesVerified: number;
  /** Scoring candidates that verified — every one of them is in the result. */
  verifiedScoringSources: number;
  /** Scoring candidates skipped unverified because their stored word_count exceeds maxCandidateWordCount. Any at all makes the result partial. */
  oversizedScoringCandidatesSkipped: number;
  candidatePagesFetched: number;
  /** Wall-clock time spent in candidate discovery (every page, including its high-frequency probe). */
  queryTimeMs: number;
  /** Wall-clock time of the whole pass. */
  matchTimeMs: number;
  /**
   * Why the pass stopped reading candidates. There is no count-based stop:
   *   CANDIDATES_EXHAUSTED — every discovered candidate was examined.
   *   TIME_BUDGET          — matchTimeBudgetMs ran out (result is partial).
   *   QUERY_FAILED         — a discovery query timed out or errored (result is partial).
   */
  stopReason: "CANDIDATES_EXHAUSTED" | "TIME_BUDGET" | "QUERY_FAILED";
  /** The `partial` flag of the returned result, as a plain boolean. */
  partial: boolean;
};

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The relationship a candidate would be reported under, or null when it
 * would not be reported at all. Depends only on who submitted the
 * representation and how it is backed — never on the text comparison — which
 * is what lets matchAgainstUserSubmissionCorpus decide it BEFORE spending
 * verification budget on the candidate.
 */
function classifyRelationship(
  ownership: SubmissionOwnershipSummary,
  isActivelyPromoted: boolean,
  accountId: string | null,
  corpusSourceMatchingEnabled: boolean,
): RelationshipType | null {
  const hasNoRealOwnership = !ownership.hasSameAccountSubmission && ownership.otherAccountSubmissionCount === 0;
  if (hasNoRealOwnership && isActivelyPromoted && corpusSourceMatchingEnabled) {
    // The fix this file's own review required: previously, zero real
    // ownership meant "drop for a signed-in account, UNKNOWN_RELATIONSHIP
    // for anonymous" unconditionally — silently hiding every
    // promoted-corpus-only match for any signed-in viewer, since a
    // promoted representation structurally never has a submission
    // reference. Applies identically regardless of accountId (this
    // describes the SOURCE, not the viewer) — see
    // matchAgainstUserSubmissionCorpus's own header comment.
    return "TURNITPLUS_CORPUS_SOURCE";
  }
  if (hasNoRealOwnership) {
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
    return accountId !== null ? null : "UNKNOWN_RELATIONSHIP";
  }
  if (accountId === null) return "UNKNOWN_RELATIONSHIP";
  return ownership.hasSameAccountSubmission ? "SELF" : "PRIOR_SUBMISSION";
}

/** The relationships lib/unified-similarity.ts counts toward the score — SELF and UNKNOWN_RELATIONSHIP are always excluded there (its DECISION 1 / DECISION 2). */
function isScoringRelationship(relationshipType: RelationshipType): boolean {
  return relationshipType === "PRIOR_SUBMISSION" || relationshipType === "TURNITPLUS_CORPUS_SOURCE";
}

/**
 * Compares one new submission's canonical text against the reusable user
 * submission corpus and returns bounded, privacy-safe historical-match
 * evidence. Never writes anything (read-only across corpus_document_
 * representations, corpus_submission_references, corpus_document_shingles,
 * corpus_admission_promotions/accepted_representations, and
 * document_identities — the last only through summarizeSubmissionOwnership's
 * own bounded query). Never touches document_families/document_family_members
 * (this phase's own task description, section 13) and never imports
 * lib/document-family.ts's resolveFamilyForIdentity.
 *
 * accountId=null (this phase's own task description, section 5): no
 * SELF/PRIOR_SUBMISSION distinction is possible without a stable account,
 * so any candidate that clears the correspondence threshold is reported as
 * UNKNOWN_RELATIONSHIP — never guessed as SELF, never silently upgraded to
 * PRIOR_SUBMISSION. TURNITPLUS_CORPUS_SOURCE (below) is the one exception:
 * it describes the SOURCE, not the viewer, so it applies identically
 * whether accountId is null or not.
 *
 * documentIdentityId, if given, excludes that one submission's own
 * corpus_submission_references row from ownership counting (via
 * summarizeSubmissionOwnership's excludeDocumentIdentityId) — relevant only
 * if the caller already indexed this exact submission into the corpus
 * before calling this function; harmless to omit otherwise.
 *
 * TIMEOUT HONESTY (this file's own review explicitly required this, after
 * an earlier draft wrapped the whole function — including the synchronous
 * correspondence loop — in Promise.race and called it a timeout, which is
 * false: Node is single-threaded for synchronous code, so a race against a
 * setTimeout cannot fire, let alone preempt anything, until the current
 * synchronous stack yields on its own; a slow computeDocumentCorrespondence
 * call blocks the event loop regardless of any timer race around it).
 * There are two real mechanisms here, deliberately different in kind:
 *   1. dbQueryTimeoutMs — a REAL race, legitimate specifically because
 *      findCandidateCorpusRepresentations is genuine async I/O: the DB
 *      driver yields the event loop while waiting, so racing it against a
 *      timer can actually abandon a hung/slow query the caller stops
 *      waiting on (the underlying request may still complete server-side;
 *      this is a "give up waiting" bound, the same honest kind every HTTP
 *      client timeout is, not true cancellation).
 *   2. matchTimeBudgetMs — a SOFT, cooperative deadline, checked only
 *      between candidates in the loop below. It can refuse to START another
 *      candidate once the budget is spent; it CANNOT interrupt a single
 *      computeDocumentCorrespondence call already running. That is exactly
 *      why maxCandidateWordCount is a HARD input limit, not a timeout — it
 *      is the only thing that actually bounds one call's own worst case.
 * A budget-exceeded exit returns whatever matches were already found (never
 * wrong, only potentially incomplete) with partial:true, so callers can
 * choose to treat it as not-yet-final rather than a confirmed result.
 *
 * CANDIDATE BUDGET. Candidates are read in one total order (shared shingles
 * descending, then representation id), a page at a time, and each one's
 * relationship is resolved BEFORE anything is spent on it:
 *   - the candidate list is never cut at a row count. v1 took
 *     `ORDER BY shared DESC LIMIT maxCandidates` first and classified
 *     afterwards, so ten of an author's own earlier drafts — SELF, never
 *     scored — occupied all ten slots and a genuine cross-account source of a
 *     copied passage was never verified: adding the author's own documents
 *     to the corpus took the score from 20 % to 0 %;
 *   - NO COUNT CAPS SCORING EVIDENCE. Every scoring candidate
 *     (PRIOR_SUBMISSION / TURNITPLUS_CORPUS_SOURCE) the pass reaches is
 *     verified, and every one that verifies is returned, so
 *     lib/unified-similarity.ts unions the positions of all of them. A cap
 *     of ten verified sources used to sit here: a submission matching a
 *     source and nine documents sharing another block scored 42 %, and a
 *     tenth such document pushed the source out and took it to 22 %. Adding
 *     a verified source can now only add positions to the union. Whatever
 *     list a view chooses to show is cut from this result afterwards and
 *     never feeds back into the score;
 *   - SELF / UNKNOWN_RELATIONSHIP candidates have their own budget of
 *     maxCandidates verification attempts, so they are still reported as
 *     before but can neither take a scoring candidate's place nor spend
 *     unbounded time on text that cannot change the score;
 *   - a candidate that would be dropped outright is never loaded.
 * The pass ends when the list is exhausted or when a time budget stops it —
 * nothing else. An exhausted pass is complete for this matcher's contract
 * (candidates sharing at least candidateShingleThreshold searched shingles).
 * `partial: true` is returned whenever a scoring candidate that was
 * discovered could NOT be verified: the time budget ran out, a discovery
 * query failed, or the candidate is over maxCandidateWordCount and was
 * skipped. The SELF/UNKNOWN budget never sets it — those candidates cannot
 * change the score. params.diagnostics records the stop reason and counts.
 */
export async function matchAgainstUserSubmissionCorpus(
  client: Client,
  params: {
    accountId: string | null;
    documentIdentityId?: string | null;
    canonicalText: string;
    config?: Partial<UserSubmissionMatchConfig>;
    /**
     * Account-level own-submission exclusion fix: the account id of the
     * report currently being evaluated, when it has one — i.e. an
     * authenticated report whose own account could, in principle, have
     * already promoted a representation of its own content, through this
     * exact report or any OTHER prior report from the same account.
     * Threaded through to findCandidateCorpusRepresentations and the
     * exact-hash fallback below so a representation backed only by this
     * account's own admission(s) is never offered as a candidate against a
     * report from that same account, while remaining fully matchable
     * against every other account. Server-internal only — never returned
     * in any match result, never derived from anything this function
     * itself looks up. Optional and undefined for every existing caller
     * that does not pass it, which reproduces the prior, unexcluded
     * behavior exactly.
     */
    excludeAccountId?: string;
    /**
     * The corpus-source-matching-enabled state this call should classify
     * under. When provided, it is used verbatim instead of a fresh
     * isCorpusSourceMatchingEnabled() read — so a caller that has already
     * captured the flag once for its whole computation
     * (lib/report-historical-match.ts's getOrComputeHistoricalMatchSnapshot)
     * cannot have this classification disagree with its own persisted
     * snapshot status across a mid-computation flag flip. Omitted by every
     * other caller, which keeps the existing single internal env read.
     */
    corpusSourceMatchingEnabled?: boolean;
    /**
     * Phase A — 7-day corpus maturity. This is a MATCHING call by definition
     * (it produces plagiarism evidence), so the 7-day gate is ALWAYS applied.
     * The production caller (lib/report-historical-match.ts's
     * getOrComputeHistoricalMatchSnapshot) threads its single logical clock's
     * cutoff string in here; a caller that omits it still gets the gate,
     * derived from `asOf ?? new Date()` below. There is deliberately no way to
     * disable maturity through this function — findCandidateCorpusRepresentations
     * and the exact-hash fallback are both invoked with eligibilityMode
     * "MATCHING" and the resolved cutoff.
     */
    maturityCutoff?: string;
    /** Fallback logical clock when no explicit maturityCutoff is threaded in. Tests inject/freeze it; production leaves it undefined (=> server time). */
    asOf?: Date;
    /** Developer/test diagnostics sink — populated in place, never returned. See UserSubmissionMatchDiagnostics. */
    diagnostics?: Partial<UserSubmissionMatchDiagnostics>;
  },
): Promise<UserSubmissionMatchResult> {
  const config = mergeConfig(params.config);
  const startedAt = Date.now();
  const deadline = startedAt + config.matchTimeBudgetMs;
  // Resolved ONCE for this whole match — a single string handed to both
  // candidate discovery and the exact-hash fallback (never asOf separately),
  // so they cannot straddle a maturity boundary. Never null: matching always
  // enforces maturity.
  const maturityCutoff = params.maturityCutoff ?? corpusMaturityCutoff(params.asOf ?? new Date());

  const queryWordCount = tokens(params.canonicalText).length;
  if (queryWordCount === 0) return { status: "NO_HISTORICAL_MATCH" };

  const queryShingles = corpusShingleHashes(params.canonicalText, config.correspondence.shingleSize);
  const candidatePageSize = config.candidatePageSize ?? USER_SUBMISSION_CANDIDATE_PAGE_SIZE;
  // params.corpusSourceMatchingEnabled, when the caller captured it once for
  // its whole computation, is used verbatim; otherwise a single internal
  // env read, exactly as before.
  const corpusSourceMatchingEnabled = params.corpusSourceMatchingEnabled ?? isCorpusSourceMatchingEnabled();

  const matches: UserSubmissionMatch[] = [];
  const examined = new Set<string>();
  let verifiedScoringSources = 0;
  let oversizedScoringCandidatesSkipped = 0;
  let nonScoringAttemptCount = 0;
  let timedOut = false;
  let stopReason: UserSubmissionMatchDiagnostics["stopReason"] = "CANDIDATES_EXHAUSTED";
  let rawCandidatesConsidered = 0;
  let eligibleCandidatesConsidered = 0;
  let candidatesVerified = 0;
  let candidatePagesFetched = 0;
  let queryTimeMs = 0;

  let offset = 0;
  let stopped = false;
  while (!stopped) {
    const isFirstPage = candidatePagesFetched === 0;
    let page: CandidateCorpusRepresentation[];
    const queryStartedAt = Date.now();
    try {
      page = await withTimeout(
        findCandidateCorpusRepresentations(client, queryShingles, {
          fingerprintVersion: config.fingerprintVersion,
          minSharedShingles: config.candidateShingleThreshold,
          limit: candidatePageSize,
          offset,
          // Verification below recomputes containment from full text; the
          // candidate's own index-level estimate is never read here.
          omitContainment: true,
          excludeAccountId: params.excludeAccountId,
          // The requester's own earlier submissions are SELF and never score,
          // so they must not make a passage look common and prune its one
          // genuine cross-account source out of discovery.
          requesterAccountId: params.accountId,
          // 10k+-corpus scale hardening — candidate DISCOVERY only. See
          // maxCandidateShingleDocumentFrequency on UserSubmissionMatchConfig
          // and lib/user-submission-corpus.ts's applyHighFrequencyShinglePruning.
          // null => no pruning and no extra DB round trip (exact prior behavior).
          maxDocumentFrequency: config.maxCandidateShingleDocumentFrequency ?? undefined,
          minDiscriminativeShingles: config.minDiscriminativeShingles,
          // Phase A: an explicit MATCHING call with the resolved cutoff;
          // findCandidateCorpusRepresentations forwards both to its DF probe.
          eligibilityMode: "MATCHING",
          maturityCutoff,
        }),
        // The first page keeps the whole dbQueryTimeoutMs, exactly as the
        // single query always did. A further page may only use what is left
        // of the pass's own budget, so paging never extends the pass.
        isFirstPage ? config.dbQueryTimeoutMs : Math.max(1, Math.min(config.dbQueryTimeoutMs, deadline - Date.now())),
        "findCandidateCorpusRepresentations",
      );
    } catch {
      // Real I/O timeout or a genuine query error — either way, failure
      // isolation means this returns a normal (non-throwing) result rather
      // than propagating: the caller (lib/report-historical-match.ts) already
      // has its own outer try/catch for anything unexpected, but a slow
      // corpus should degrade to "nothing more found this time," not an
      // error. Whatever earlier pages already verified is kept.
      queryTimeMs += Date.now() - queryStartedAt;
      timedOut = true;
      stopReason = "QUERY_FAILED";
      break;
    }
    queryTimeMs += Date.now() - queryStartedAt;
    candidatePagesFetched += 1;
    offset += page.length;
    const exhausted = page.length < candidatePageSize;

    let ordered = page;
    if (isFirstPage) {
      // Defensive guarantee for exact/formatting-only duplicates (sections
      // 10/11): an identical canonical text always has identical shingles and
      // would ordinarily be found by the search above anyway, but a very short
      // document could have fewer shingles than candidateShingleThreshold —
      // this makes the exact-duplicate case correct regardless of that knob.
      // Never reached if the shingle search above already timed out — no
      // point spending another DB round trip against a corpus that just
      // proved slow. It is examined FIRST, ahead of the ranked list, so no
      // number of equally-ranked candidates can keep it from being verified.
      const exactHash = canonicalSha256(params.canonicalText);
      const exactRepresentation = await findReusableRepresentationByCanonicalHash(client, exactHash);
      const exactInPage = exactRepresentation ? page.find((c) => c.representationId === exactRepresentation.id) : undefined;
      if (exactInPage) {
        ordered = [exactInPage, ...page.filter((c) => c !== exactInPage)];
      } else if (exactRepresentation) {
        // Own-submission exclusion fix: findReusableRepresentationByCanonicalHash is a
        // plain hash lookup with no eligibility awareness of its own (it is
        // also used by lib/corpus-admission-promotion.ts's own find-or-create
        // dedup logic, where eligibility is irrelevant) — this fallback must
        // apply the SAME eligibility rule findCandidateCorpusRepresentations'
        // own WHERE clause already enforces for its shingle-based candidates.
        // A byte-identical self-upload of a just-promoted document is exactly
        // an exact-hash match, so leaving this fallback ungated would make
        // excludeAccountId above a no-op for the precise scenario it exists
        // to close. Phase A: the SAME MATCHING gate and resolved cutoff too — an
        // exact-canonical duplicate of an immature corpus source must not slip in
        // via this fallback when the shingle search already correctly excluded it.
        const eligible = await isRepresentationEligibleForMatching(client, exactRepresentation.id, {
          excludeAccountId: params.excludeAccountId,
          eligibilityMode: "MATCHING",
          maturityCutoff,
        });
        if (eligible) {
          ordered = [
            {
              representationId: exactRepresentation.id,
              canonicalSha256: exactRepresentation.canonicalSha256,
              wordCount: exactRepresentation.wordCount,
              sharedShingleCount: queryShingles.size,
              containment: 1,
              isActivelyPromoted: await isRepresentationActivelyPromoted(client, exactRepresentation.id),
            },
            ...page,
          ];
        }
      }
    }

    // A later page can repeat a row (the exact-canonical candidate above, or
    // a row shifted by a concurrent corpus write) — examine each once.
    const candidates = ordered.filter((c) => !examined.has(c.representationId));
    for (const candidate of candidates) examined.add(candidate.representationId);
    rawCandidatesConsidered += candidates.length;

    // One round trip resolves who submitted every candidate on this page, so
    // each candidate's relationship is known before any text is loaded.
    const ownershipById = await summarizeSubmissionOwnershipForRepresentations(
      client,
      candidates.map((c) => c.representationId),
      { accountId: params.accountId, excludeDocumentIdentityId: params.documentIdentityId ?? null },
    );

    for (const candidate of candidates) {
      const ownership = ownershipById.get(candidate.representationId) ?? { hasSameAccountSubmission: false, otherAccountSubmissionCount: 0 };
      const relationshipType = classifyRelationship(ownership, candidate.isActivelyPromoted, params.accountId, corpusSourceMatchingEnabled);
      if (relationshipType === null) continue; // would be dropped whatever the text comparison said — never loaded
      const scoring = isScoringRelationship(relationshipType);
      if (scoring) eligibleCandidatesConsidered += 1;
      // SELF / UNKNOWN_RELATIONSHIP beyond their own budget: passed over
      // without loading — they cannot change the score, and must not spend
      // the time a scoring candidate further down the list still needs.
      else if (nonScoringAttemptCount >= config.maxCandidates) continue;

      // HARD input limit: never run correspondence comparison against an
      // oversized candidate document at all, regardless of the time budget.
      // A scoring candidate skipped this way is evidence that was discovered
      // and never verified, so the result is partial — it must not read as a
      // complete score.
      if (candidate.wordCount > config.maxCandidateWordCount) {
        if (scoring) oversizedScoringCandidatesSkipped += 1;
        continue;
      }

      // Cooperative deadline check — see this function's own TIMEOUT HONESTY
      // comment: this can only decline to start the NEXT candidate, never
      // interrupt one already in progress.
      if (Date.now() >= deadline) {
        timedOut = true;
        stopReason = "TIME_BUDGET";
        stopped = true;
        break;
      }
      if (!scoring) nonScoringAttemptCount += 1;

      const representation = await findRepresentationById(client, candidate.representationId);
      if (!representation) continue; // defensive: representation was removed between the two queries

      const correspondence = computeDocumentCorrespondence(params.canonicalText, representation.canonicalText, config.correspondence);
      candidatesVerified += 1;
      // Section 19/20: textual evidence is required — title/author alone,
      // and weak/common-phrase overlap alone, never produce a match here.
      // Phase 6.6 PART 2: distinctivePassageMatch is a THIRD, independent
      // acceptance path alongside the pre-existing two — a single
      // sufficiently long, contiguous, exact/near-exact passage is now
      // reportable evidence on its own even when the source document's
      // overall containment ratio is low (see USER_SUBMISSION_MATCH_THRESHOLDS's
      // own minimumDistinctivePassageWords comment). Fragmented evidence
      // (several short spans that never individually reach the threshold) is
      // still rejected here exactly as before — distinctivePassageMatch is
      // computed from the SINGLE longest span, never a sum across spans.
      if (!correspondence.exactCanonicalMatch && !correspondence.strongCorrespondence && !correspondence.distinctivePassageMatch) continue;

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

      // No count ends the pass here: every verified scoring source is kept,
      // and the next candidate is read.
      if (scoring) verifiedScoringSources += 1;
    }

    if (stopped || exhausted) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      stopReason = "TIME_BUDGET";
      break;
    }
  }

  // Partial whenever a discovered scoring candidate went unverified: the pass
  // was stopped by a time budget / failed query, or a candidate was over the
  // size limit. Never set by the SELF/UNKNOWN budget.
  const isPartial = timedOut || oversizedScoringCandidatesSkipped > 0;

  if (params.diagnostics) {
    Object.assign(params.diagnostics, {
      rawCandidatesConsidered,
      eligibleCandidatesConsidered,
      candidatesVerified,
      verifiedScoringSources,
      oversizedScoringCandidatesSkipped,
      candidatePagesFetched,
      queryTimeMs,
      matchTimeMs: Date.now() - startedAt,
      stopReason,
      partial: isPartial,
    } satisfies UserSubmissionMatchDiagnostics);
  }

  const partial = isPartial ? true : undefined;
  if (matches.length === 0) return { status: "NO_HISTORICAL_MATCH", partial };

  matches.sort(compareMatches);
  return { status: "MATCHED", matches, partial };
}
