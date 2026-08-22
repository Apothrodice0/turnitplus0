import type { Client } from "@libsql/client";
import { tokens } from "./similarity-core";
import { canonicalSha256 } from "./document-identity";
import {
  corpusShingleHashes,
  findCandidateCorpusRepresentations,
  findReusableRepresentationByCanonicalHash,
  findRepresentationById,
  summarizeSubmissionOwnership,
  isRepresentationActivelyPromoted,
  CORPUS_FINGERPRINT_VERSION,
  type CandidateCorpusRepresentation,
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
 * 15): the only function anywhere that looks at which accounts submitted a
 * representation is lib/user-submission-corpus.ts's
 * summarizeSubmissionOwnership, and its own return type has no room for an
 * account id — only a boolean and a count. This module never queries
 * document_identities.account_id, users, or emails directly.
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
  maxCandidates: number;
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
   */
  maxCandidateWordCount: number;
  /**
   * SOFT, cooperative deadline for the whole matching pass — checked ONLY
   * between candidates in the correspondence loop, never mid-computation.
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
  const deadline = Date.now() + config.matchTimeBudgetMs;

  const queryWordCount = tokens(params.canonicalText).length;
  if (queryWordCount === 0) return { status: "NO_HISTORICAL_MATCH" };

  const queryShingles = corpusShingleHashes(params.canonicalText, config.correspondence.shingleSize);

  let shingleCandidates: CandidateCorpusRepresentation[];
  let dbTimedOut = false;
  try {
    shingleCandidates = await withTimeout(
      findCandidateCorpusRepresentations(client, queryShingles, {
        fingerprintVersion: config.fingerprintVersion,
        minSharedShingles: config.candidateShingleThreshold,
        limit: config.maxCandidates,
      }),
      config.dbQueryTimeoutMs,
      "findCandidateCorpusRepresentations",
    );
  } catch {
    // Real I/O timeout or a genuine query error — either way, failure
    // isolation means this returns a normal (non-throwing) result rather
    // than propagating: the caller (lib/report-historical-match.ts) already
    // has its own outer try/catch for anything unexpected, but a slow
    // corpus should degrade to "nothing found this time," not an error.
    shingleCandidates = [];
    dbTimedOut = true;
  }

  // Defensive guarantee for exact/formatting-only duplicates (sections
  // 10/11): an identical canonical text always has identical shingles and
  // would ordinarily be found by the search above anyway, but a very short
  // document could have fewer shingles than candidateShingleThreshold —
  // this makes the exact-duplicate case correct regardless of that knob.
  // Skipped entirely if the shingle search above already timed out — no
  // point spending another DB round trip against a corpus that just proved
  // slow.
  const candidateById = new Map<string, CandidateCorpusRepresentation>(shingleCandidates.map((c) => [c.representationId, c]));
  if (!dbTimedOut) {
    const exactHash = canonicalSha256(params.canonicalText);
    const exactRepresentation = await findReusableRepresentationByCanonicalHash(client, exactHash);
    if (exactRepresentation && !candidateById.has(exactRepresentation.id)) {
      candidateById.set(exactRepresentation.id, {
        representationId: exactRepresentation.id,
        canonicalSha256: exactRepresentation.canonicalSha256,
        wordCount: exactRepresentation.wordCount,
        sharedShingleCount: queryShingles.size,
        containment: 1,
        isActivelyPromoted: await isRepresentationActivelyPromoted(client, exactRepresentation.id),
      });
    }
  }

  const boundedCandidates = [...candidateById.values()].slice(0, config.maxCandidates);
  const matches: UserSubmissionMatch[] = [];
  const corpusSourceMatchingEnabled = isCorpusSourceMatchingEnabled();
  let timedOut = dbTimedOut;

  for (const candidate of boundedCandidates) {
    // Cooperative deadline check — see this function's own TIMEOUT HONESTY
    // comment: this can only decline to start the NEXT candidate, never
    // interrupt one already in progress.
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }

    // HARD input limit: never run correspondence comparison against an
    // oversized candidate document at all, regardless of the time budget.
    if (candidate.wordCount > config.maxCandidateWordCount) continue;

    const representation = await findRepresentationById(client, candidate.representationId);
    if (!representation) continue; // defensive: representation was removed between the two queries

    const correspondence = computeDocumentCorrespondence(params.canonicalText, representation.canonicalText, config.correspondence);
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

    const ownership = await summarizeSubmissionOwnership(client, representation.id, {
      accountId: params.accountId,
      excludeDocumentIdentityId: params.documentIdentityId ?? null,
    });
    const hasNoRealOwnership = !ownership.hasSameAccountSubmission && ownership.otherAccountSubmissionCount === 0;

    let relationshipType: RelationshipType;
    if (hasNoRealOwnership && candidate.isActivelyPromoted && corpusSourceMatchingEnabled) {
      // The fix this file's own review required: previously, zero real
      // ownership meant "drop for a signed-in account, UNKNOWN_RELATIONSHIP
      // for anonymous" unconditionally — silently hiding every
      // promoted-corpus-only match for any signed-in viewer, since a
      // promoted representation structurally never has a submission
      // reference. Applies identically regardless of accountId (this
      // describes the SOURCE, not the viewer) — see this function's own
      // header comment.
      relationshipType = "TURNITPLUS_CORPUS_SOURCE";
    } else if (hasNoRealOwnership) {
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
      if (params.accountId !== null) continue;
      relationshipType = "UNKNOWN_RELATIONSHIP";
    } else if (params.accountId === null) {
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

  const partial = timedOut ? true : undefined;
  if (matches.length === 0) return { status: "NO_HISTORICAL_MATCH", partial };

  matches.sort(compareMatches);
  return { status: "MATCHED", matches, partial };
}
