/**
 * Phase E8O: PRODUCTION HISTORICAL-MATCH ACCEPTANCE SPECIFICATION.
 *
 * This file is a DESIGN DOCUMENT expressed as TypeScript, not a new
 * algorithm. It defines types, a proposed taxonomy, a pure decision
 * function, and threshold metadata for how a FUTURE implementation phase
 * could combine:
 *   - the EXISTING, unchanged, in-production whole-document matcher
 *     (lib/user-submission-matching.ts's matchAgainstUserSubmissionCorpus,
 *     USER_SUBMISSION_MATCH_THRESHOLDS), and
 *   - the EXPERIMENTAL passage-level correspondence + distinctiveness work
 *     from Phases E8K/E8L/E8M/E8N (lib/e8m-robust-correspondence.ts,
 *     lib/e8l-distinctiveness-v2.ts), which E8N's own locked-holdout
 *     evaluation (tools/e8n-large-calibration.ts, variant F_E8M_V2) is the
 *     empirical basis for every "EVIDENCE_BACKED" threshold below.
 *
 * Deliberately import-free of every production/experimental correspondence
 * module (document-correspondence.ts, e8m-robust-correspondence.ts,
 * e8l-distinctiveness-v2.ts, user-submission-matching.ts, user-submission-
 * corpus.ts, @libsql/client). This file only classifies ALREADY-COMPUTED
 * signals — it never computes a signal itself and never touches a
 * database. That keeps it a pure specification: a later implementation
 * phase can port this decision logic into production code directly, and
 * this phase's own acceptance-matrix tool (tools/e8o-acceptance-matrix.ts)
 * can validate it against real text using E8J-E8N's already-built
 * fixtures, without this module ever importing either side itself.
 *
 * RelationshipType below intentionally re-declares (does not import)
 * lib/user-submission-matching.ts's own RelationshipType vocabulary
 * verbatim — the same "reuse the values, not the import" pattern that
 * file's own header comment already uses for FamilyMatchType. Values must
 * stay byte-identical to lib/user-submission-matching.ts:58; see
 * tests/e8o-policy-spec.test.mjs's literal cross-check.
 *
 * MUST NOT be imported by lib/user-submission-matching.ts or any other
 * production matcher/scoring code in this phase. See this file's own
 * structural test in tests/e8o-policy-spec.test.mjs.
 */

// ============================================================================
// SECTION 1 — SIGNALS (kept explicitly separate; never merged into one score)
// ============================================================================

/**
 * The EXISTING production signal, unchanged. Field names/semantics mirror
 * lib/document-correspondence.ts's DocumentCorrespondenceResult and
 * lib/user-submission-matching.ts's per-match fields exactly, so a real
 * implementation can populate this directly from computeDocumentCorrespondence's
 * output plus USER_SUBMISSION_MATCH_THRESHOLDS without translation.
 */
export type WholeDocumentSignal = {
  exactCanonicalMatch: boolean;
  /** = computeDocumentCorrespondence's own strongCorrespondence, i.e. containment >= strongContainmentThreshold && matchedWordCount >= minimumMatchedWords, using PRODUCTION's real USER_SUBMISSION_MATCH_THRESHOLDS.correspondence. Never recomputed with different numbers here. */
  meetsProductionThreshold: boolean;
  containment: number;
  matchedWordCount: number;
  longestMatchWords: number;
};

/**
 * The EXPERIMENTAL signal from E8M (robust correspondence) + V2
 * (distinctiveness), i.e. E8N's "F_E8M_V2" pipeline variant — the only
 * variant, alongside D_V0_V2, that reached precision=1.000/recall=1.000 on
 * E8N's locked 17-case holdout. null when a caller chooses not to compute
 * it (see classifyHistoricalMatch's Step 4 / section 8's "Option B").
 */
export type PassageLevelSignal = {
  matchedWordCount: number;
  longestMatchWords: number;
  /** The single longest individual passage's own word count — distinct from longestMatchWords only when a correspondence engine's "longest match" is itself an aggregate; kept as its own field so the "at least one substantial passage" guardrail (Section 5) never has to assume the two are the same thing. */
  longestSinglePassageWords: number;
  passageCount: number;
  passageDensity: number;
  distinctivenessV2: number;
};

// ============================================================================
// SECTION 2 — TAXONOMY
// ============================================================================

/**
 * Three-way EVIDENCE-STRENGTH status. Deliberately NOT named after
 * "plagiarism" (this phase's own instruction) — this is a description of
 * what TEXTUAL EVIDENCE was found, not a verdict about the submitter's
 * conduct. HISTORICAL_FULL_MATCH is a strict superset of what today's
 * production UserSubmissionMatchResult already reports as "MATCHED": every
 * case that qualifies today (exact or strongCorrespondence) still
 * qualifies here, unchanged (Section 4, Step 1-2). HISTORICAL_PARTIAL_MATCH
 * is new: evidence strong enough to report, but not strong enough to claim
 * whole-document correspondence.
 */
export type HistoricalMatchStatus = "NO_HISTORICAL_MATCH" | "HISTORICAL_FULL_MATCH" | "HISTORICAL_PARTIAL_MATCH";

/**
 * Byte-identical to lib/user-submission-matching.ts's own RelationshipType
 * (see this file's header comment) — re-declared, not imported.
 * Independent of HistoricalMatchStatus by design (Section 3): relationship
 * describes WHO submitted the matched content relative to the current
 * account, and is computed the same way production already computes it
 * today (summarizeSubmissionOwnership), regardless of which evidence path
 * (full or partial) produced the match.
 */
export type RelationshipType = "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP";

/**
 * Per-match evidence kind. EXACT_CANONICAL_MATCH and
 * STRONG_WHOLE_DOCUMENT_CORRESPONDENCE are production's own
 * UserSubmissionMatchType values, renamed for clarity but semantically
 * identical (EXACT_CANONICAL_MATCH is literally the same field;
 * STRONG_WHOLE_DOCUMENT_CORRESPONDENCE = production's STRONG_TEXT_MATCH).
 * The remaining three are new, passage-level-only kinds.
 */
export type EvidenceKind =
  | "EXACT_CANONICAL_MATCH"
  | "STRONG_WHOLE_DOCUMENT_CORRESPONDENCE"
  | "STRONG_DISTINCTIVE_PASSAGE"
  | "MULTIPLE_DISTINCTIVE_PASSAGES"
  | "WEAK_NON_QUALIFYING_OVERLAP";

export type HistoricalMatchClassification = {
  status: HistoricalMatchStatus;
  evidence: EvidenceKind;
  relationship: RelationshipType;
  wholeDocumentSignal: WholeDocumentSignal;
  /** null exactly when the passage-level path was never evaluated (short-circuited by a whole-document match, or skipped by the short-document guardrail, or the caller chose not to compute it). */
  passageLevelSignal: PassageLevelSignal | null;
  policyVersion: string;
};

// ============================================================================
// SECTION 12 — VERSIONING (proposed only; none of these touch production's
// real version strings — lib/user-submission-matching.ts's own
// USER_SUBMISSION_MATCHER_VERSION="user-submission-match-v1" is untouched).
// ============================================================================

/** Reused unchanged from lib/e8m-robust-correspondence.ts's own ROBUST_CORRESPONDENCE_VERSION constant value ("e8m-v1") — repeated here as a literal, not imported, to keep this file import-free; see tests/e8o-policy-spec.test.mjs for the cross-check. */
export const PROPOSED_ROBUST_CORRESPONDENCE_VERSION = "e8m-v1";
/** Reused unchanged from lib/e8l-distinctiveness-v2.ts's own DISTINCTIVENESS_MODEL_V2 constant value. */
export const PROPOSED_DISTINCTIVENESS_MODEL_VERSION = "e8l-distinctiveness-v2";
/** New: identifies THIS decision policy (taxonomy + decision tree + thresholds) independently of which correspondence/distinctiveness engine versions it happens to combine. */
export const PROPOSED_ACCEPTANCE_POLICY_VERSION = "e8o-policy-v1";
/** New: what a real implementation might call the combined matcher once passage-level evidence is wired in. Production's real matcherVersion stays "user-submission-match-v1" until a separately-approved implementation phase changes it. */
export const PROPOSED_HISTORICAL_MATCHER_VERSION = "historical-matcher-v2-proposed";

// ============================================================================
// SECTION 10 — MINIMUM EVIDENCE REQUIREMENTS (proposed threshold metadata)
// ============================================================================

export type EvidenceStatus = "EVIDENCE_BACKED" | "ENGINEERING_DEFAULT" | "PRODUCTION_INHERITED" | "UNRESOLVED";

export type SpecifiedValue<T> = {
  value: T;
  status: EvidenceStatus;
  /** Cites the specific phase/finding this value traces to, or explains why it does not yet trace to one. */
  rationale: string;
};

export type ProposedAcceptanceThresholds = {
  minimumMatchedWords: SpecifiedValue<number>;
  minimumLongestPassageWords: SpecifiedValue<number>;
  minimumPassageDensity: SpecifiedValue<number>;
  minimumDistinctiveness: SpecifiedValue<number>;
  minimumSinglePassageWords: SpecifiedValue<number>;
  minimumDocumentWordCountForPartialMatch: SpecifiedValue<number>;
};

export const PROPOSED_ACCEPTANCE_THRESHOLDS: ProposedAcceptanceThresholds = {
  minimumMatchedWords: {
    value: 50,
    status: "EVIDENCE_BACKED",
    rationale: "E8N's own train-selected threshold (tools/e8n-large-calibration.ts's threshold sweep, section 5), the only swept configuration that reached precision=1.000/recall=1.000 for pipeline variants D (V0+V2) and F (E8M+V2) on the locked 17-case holdout that was never used for tuning.",
  },
  minimumLongestPassageWords: {
    value: 50,
    status: "EVIDENCE_BACKED",
    rationale: "Same E8N sweep as minimumMatchedWords, same threshold configuration.",
  },
  minimumPassageDensity: {
    value: 0.05,
    status: "EVIDENCE_BACKED",
    rationale: "Same E8N sweep. Observed to rarely be the binding constraint in E8N's fixture set — kept as a loose floor against pathologically sparse passage spans, not as a primary discriminator.",
  },
  minimumDistinctiveness: {
    value: 0.7,
    status: "EVIDENCE_BACKED",
    rationale: "E8N's swept, holdout-validated V2 distinctiveness gate. Sensitivity caveat: E8N's own multi-block deep-dive (report section 8) found genuine copied-content cases ('landmark-multi-block', 'appended-one-long-block') scoring 0.693-0.697 — just under this cutoff. Treat 0.7 as a specific validated point within a plausible 0.65-0.75 operating range, not a value with no measured near-misses.",
  },
  minimumSinglePassageWords: {
    value: 40,
    status: "ENGINEERING_DEFAULT",
    rationale: "NOT directly swept in E8J-E8N. Proposed defense-in-depth guardrail (Section 9) against a 'many short generic overlaps' case where an aggregate matchedWordCount/distinctiveness could clear the floor above without any single passage being individually substantial — the original false-positive concern E8K/E8L's own reports raised. E8N's 'appended-many-short-blocks' fixture (COMMON_BOILERPLATE, correctly rejected via low V2 distinctiveness alone) did not specifically stress-test this guardrail in isolation; it is included as an additional, independently-justified check, not a re-derivation of an E8N-measured number.",
  },
  minimumDocumentWordCountForPartialMatch: {
    value: 100,
    status: "ENGINEERING_DEFAULT",
    rationale: "E8K's SMALL_PASSAGE_100 fixture (100 words) did not clear the passage-level acceptance floor even when genuinely reused text (tools/e8k-passage-calibration-report.ts). Below this length, matched-word and distinctiveness statistics are built from very few shingles/anchors and are inherently less stable. The exact minimum was not independently swept across a 50-150 word range — see Section 11's UNRESOLVED note.",
  },
};

// ============================================================================
// SECTION 4 — DECISION TREE
// ============================================================================

export type ClassifyHistoricalMatchInput = {
  wholeDocument: WholeDocumentSignal;
  /**
   * null means "not computed for this candidate." A real implementation
   * following Section 8's chosen Option B ("only run E8M+V2 for
   * candidates that fail whole-document acceptance") would only ever
   * populate this when wholeDocument.exactCanonicalMatch and
   * wholeDocument.meetsProductionThreshold are both false — but this
   * function does not enforce that itself; it only requires that null be
   * honestly passed when no passage-level evidence exists to evaluate.
   */
  passageLevel: PassageLevelSignal | null;
  relationship: RelationshipType;
  /** Word count of the CURRENT submission (not the historical candidate) — drives the short-document guardrail, Section 11. */
  submittedWordCount: number;
  thresholds?: ProposedAcceptanceThresholds;
};

function build(
  status: HistoricalMatchStatus,
  evidence: EvidenceKind,
  input: ClassifyHistoricalMatchInput,
  passageLevelSignal: PassageLevelSignal | null,
): HistoricalMatchClassification {
  return {
    status,
    evidence,
    relationship: input.relationship,
    wholeDocumentSignal: input.wholeDocument,
    passageLevelSignal,
    policyVersion: PROPOSED_ACCEPTANCE_POLICY_VERSION,
  };
}

/**
 * Pure decision function — no I/O, no correspondence computation. Given
 * already-computed signals, returns the proposed classification.
 *
 * Step order is deliberate and mirrors Section 8's chosen design ("E8M+V2
 * only augments what V0 already misses; it can never downgrade or
 * override a V0 whole-document match"):
 *   1. Exact canonical match — always definitive (E8K/E8M's own "exact
 *      must never disagree with the obvious case" principle).
 *   2. Production's EXISTING strong whole-document threshold — zero
 *      behavior change versus today's matchAgainstUserSubmissionCorpus.
 *   3. Short-document guardrail (Section 11) — below the minimum length,
 *      do not attempt a passage-level partial-match classification at all.
 *   4. No passage-level signal available — nothing further to evaluate.
 *   5. Passage-level acceptance region — multiple independent guardrails
 *      (Section 9), none sufficient alone: an evidence floor
 *      (matched/longest/density/count), a distinctiveness gate, AND a
 *      "not just many short overlaps" per-passage floor.
 */
export function classifyHistoricalMatch(input: ClassifyHistoricalMatchInput): HistoricalMatchClassification {
  const thresholds = input.thresholds ?? PROPOSED_ACCEPTANCE_THRESHOLDS;
  const { wholeDocument, passageLevel, submittedWordCount } = input;

  if (wholeDocument.exactCanonicalMatch) {
    return build("HISTORICAL_FULL_MATCH", "EXACT_CANONICAL_MATCH", input, passageLevel);
  }

  if (wholeDocument.meetsProductionThreshold) {
    return build("HISTORICAL_FULL_MATCH", "STRONG_WHOLE_DOCUMENT_CORRESPONDENCE", input, passageLevel);
  }

  if (submittedWordCount < thresholds.minimumDocumentWordCountForPartialMatch.value) {
    return build("NO_HISTORICAL_MATCH", "WEAK_NON_QUALIFYING_OVERLAP", input, passageLevel);
  }

  if (!passageLevel) {
    return build("NO_HISTORICAL_MATCH", "WEAK_NON_QUALIFYING_OVERLAP", input, null);
  }

  const meetsEvidenceFloor =
    passageLevel.matchedWordCount >= thresholds.minimumMatchedWords.value &&
    passageLevel.longestMatchWords >= thresholds.minimumLongestPassageWords.value &&
    passageLevel.passageDensity >= thresholds.minimumPassageDensity.value &&
    passageLevel.passageCount >= 1;
  const meetsDistinctiveness = passageLevel.distinctivenessV2 >= thresholds.minimumDistinctiveness.value;
  const hasSubstantialSinglePassage = passageLevel.longestSinglePassageWords >= thresholds.minimumSinglePassageWords.value;

  if (meetsEvidenceFloor && meetsDistinctiveness && hasSubstantialSinglePassage) {
    const evidence: EvidenceKind = passageLevel.passageCount > 1 ? "MULTIPLE_DISTINCTIVE_PASSAGES" : "STRONG_DISTINCTIVE_PASSAGE";
    return build("HISTORICAL_PARTIAL_MATCH", evidence, input, passageLevel);
  }

  return build("NO_HISTORICAL_MATCH", "WEAK_NON_QUALIFYING_OVERLAP", input, passageLevel);
}

// ============================================================================
// SECTION 8 — WHERE E8M BELONGS (chosen option, as data + rationale)
// ============================================================================

export type E8MRolePlacement = "ALWAYS_REPLACE_V0" | "ONLY_FOR_FAILED_WHOLE_DOCUMENT_CANDIDATES" | "PARALLEL_COMPARE" | "ONLY_WHEN_STRONG_ANCHORS_PRESENT";

export const CHOSEN_E8M_ROLE_PLACEMENT: { option: E8MRolePlacement; rationale: string } = {
  option: "ONLY_FOR_FAILED_WHOLE_DOCUMENT_CANDIDATES",
  rationale:
    "E8J showed V0 alone is already correct for exact/formatting-only/light/moderate/heavy-edit cases; E8N showed E8M-alone (variant B) performs no better than V0-alone (variant A) on the locked holdout (both recall=0.286) — E8M's measured value is specifically in RECOVERING cases V0 misses (E8M's worked 'rising from 81% to 94%' example; E8N's sentence-restructuring adversarial cases), not in replacing a path that already works. Running E8M only for candidates that already failed whole-document acceptance (a) matches the exact structure of E8N's best-performing variants D/F, which layer distinctiveness on top of a correspondence engine rather than letting a correspondence engine alone decide, (b) never risks disturbing the already-correct V0 path, and (c) avoids computing a second correspondence pass for the common case where V0 already found a conclusive match. 'Parallel-compare' (Option C) is proposed instead for Stage 0 shadow-mode observability (Section 16), where the goal is measurement, not a live decision.",
};

// ============================================================================
// SECTION 5 / 9 — MULTI-BLOCK & FALSE-POSITIVE GUARDRAIL NOTES (documentation)
// ============================================================================

export const MULTI_BLOCK_POLICY_NOTES = [
  "'Longest passage' alone must never decide acceptance — the decision tree's evidence floor uses matchedWordCount (aggregate across all passages) alongside longestMatchWords, and V2 distinctiveness (rareMultiword/corpusFrequency/entitySignal) is computed over ALL matched-passage shingles, not just the longest passage's.",
  "'Several medium distinctive passages' (E8N's landmark-multi-block-style cases) are handled identically to a single long passage by the aggregate evidence floor — passageCount itself is neither a bonus nor a penalty in the decision tree.",
  "'Many short generic overlaps' (E8N's appended-many-short-blocks fixture, COMMON_BOILERPLATE) are correctly rejected primarily via low V2 distinctiveness (observed 0.514-0.523, well under the 0.7 gate) — the minimumSinglePassageWords guardrail is a proposed, NOT independently E8N-measured, second line of defense for a case where many short overlaps happened to sum to a high aggregate score without any single substantial passage.",
] as const;

export const FALSE_POSITIVE_GUARDRAIL_NOTES = [
  "No single metric decides HISTORICAL_PARTIAL_MATCH: the decision tree requires the evidence floor (matched/longest/density/count) AND the V2 distinctiveness gate AND the single-passage substantiality guardrail to all hold simultaneously.",
  "Generic boilerplate / common phrases: rejected primarily by V2 distinctiveness, which E8L/E8N validated achieves clean separation from genuine distinctive-copy cases at the tested corpus size (E8L: GENERIC range [0.546,0.623] vs DISTINCTIVE_COPY [1.000,1.000]) — where V1 (the alternative model) did not (overlapping [0.864,0.985] vs [0.968,0.984]).",
  "Same-topic-different-wording: E8J/E8N's SAME_TOPIC fixtures produce low matchedWordCount/longestMatchWords (little literal text overlap survives paraphrase-level rewriting), so they are rejected at the evidence-floor step before distinctiveness is even the deciding factor.",
  "Repeated internal boilerplate: V2's own internalRepetition feature (lib/e8l-distinctiveness-v2.ts's featureInternalRepetition, folded into combineV2 with a -0.20 weight) penalizes text the submitter repeats many times within their own document — inherited unchanged from E8L/E8N's already-validated formula.",
  "Corpus-scarce-but-generic text (UNRESOLVED — see Section 10/19): E8L's own corpus-frequency feature was documented as showing only weak separation GIVEN THE FIXED 116-document corpus size used throughout E8L-E8N. A small or sparse real historical corpus could let genuinely generic text score as artificially 'rare' simply because the corpus lacks other instances of it. This phase does not propose a specific minimum-corpus-size gate, since that dimension was never varied in E8L-E8N's own experiments — flagged as an open question for a future calibration phase, not decided here.",
] as const;

// ============================================================================
// SECTION 13 — UI / EXPLANATION CONTRACT
// ============================================================================

export type UiContractEntry = {
  status: HistoricalMatchStatus;
  whatIsShown: readonly string[];
  disclaimer: string;
};

export const UI_CONTRACT: readonly UiContractEntry[] = [
  {
    status: "NO_HISTORICAL_MATCH",
    whatIsShown: ["Nothing beyond today's existing behavior — no historical-match section rendered."],
    disclaimer: "N/A",
  },
  {
    status: "HISTORICAL_FULL_MATCH",
    whatIsShown: [
      "Containment percentage and matched word count (as today).",
      "Bounded excerpt passages of the CURRENT submission's own text only (as today — never the historical document's text).",
      "Relationship badge: SELF, PRIOR_SUBMISSION, or UNKNOWN_RELATIONSHIP, with no other account's identity ever exposed (as today).",
    ],
    disclaimer: "This reflects textual correspondence with a prior TurnitPlus submission. It is historical submission evidence, not a plagiarism verdict.",
  },
  {
    status: "HISTORICAL_PARTIAL_MATCH",
    whatIsShown: [
      "Explicit 'partial match' framing, visually distinct from a full match — never presented with the same visual weight as HISTORICAL_FULL_MATCH.",
      "Which passages of the CURRENT document correspond (bounded excerpts, current-document-only, same privacy property as full match).",
      "Matched word count as a fraction/coverage of the whole submitted document (so a reader understands 'part of', not 'all of', the document is implicated).",
      "Relationship badge, same rules as HISTORICAL_FULL_MATCH.",
    ],
    disclaimer: "This reflects partial textual correspondence with a prior TurnitPlus submission, identified by an experimental passage-matching signal. It is historical submission evidence only, not a plagiarism verdict, and does not by itself indicate the remainder of the document is original.",
  },
];

// ============================================================================
// SECTION 14 — SCORE-SEPARATION CONTRACT
// ============================================================================

export const SCORE_SEPARATION_CONTRACT =
  "Historical-match status (of any kind — full or partial) does NOT modify report.score, archiveScore, aiScore, or verifiedSimilarity in this specification. Those scoring pipelines are untouched by every phase from E8B through E8O. Any future change coupling historical-match evidence to a numeric score is explicitly OUT OF SCOPE here and would require its own separately-approved, separately-calibrated phase — this specification proposes a DISPLAY/EVIDENCE contract only.";

// ============================================================================
// SECTION 15 — PRIVACY / RETENTION CONTRACT
// ============================================================================

export type PrivacyContractItem = { guarantee: string; status: EvidenceStatus };

export const PRIVACY_RETENTION_CONTRACT: readonly PrivacyContractItem[] = [
  { guarantee: "Passages shown are excerpts of the CURRENT submission's own text only — never the historical document's text.", status: "PRODUCTION_INHERITED" },
  { guarantee: "No historical document full text is ever disclosed to the viewer.", status: "PRODUCTION_INHERITED" },
  { guarantee: "No historical submitter account identity is ever disclosed — only relationship (SELF/PRIOR_SUBMISSION/UNKNOWN_RELATIONSHIP) and an other-account count, mirroring summarizeSubmissionOwnership's existing bounded return shape.", status: "PRODUCTION_INHERITED" },
  { guarantee: "Evidence payloads are bounded (maxPassages/maxPassageWords-style caps), not unbounded excerpt dumps.", status: "PRODUCTION_INHERITED" },
  { guarantee: "Historical-match evidence retention duration.", status: "UNRESOLVED" },
  { guarantee: "Whether a user can request their own historical-match evidence (as a matched CANDIDATE, i.e. the older submission) be excluded from future matching.", status: "UNRESOLVED" },
  { guarantee: "Cross-jurisdiction data-handling rules applicable to historical-match evidence.", status: "UNRESOLVED" },
] as const;

// ============================================================================
// SECTION 16 — STAGED ROLLOUT PLAN
// ============================================================================

export type RolloutStage = { stage: 0 | 1 | 2 | 3; name: string; description: string; rollbackTrigger: string };

export const ROLLOUT_PLAN: readonly RolloutStage[] = [
  {
    stage: 0,
    name: "Shadow mode",
    description: "Compute HISTORICAL_PARTIAL_MATCH status for real submissions (Option B routing: only for candidates that already fail whole-document acceptance) but do not render it in the UI or persist it as authoritative evidence. Log only the observability metrics in Section 17 (never document content). Duration: proposed as a minimum data-volume window rather than a fixed calendar duration (ENGINEERING_DEFAULT — real submission volume is not known from this local-only phase); a specific number of weeks/submissions is UNRESOLVED pending real traffic data.",
    rollbackTrigger: "N/A — nothing user-visible changes in this stage.",
  },
  {
    stage: 1,
    name: "Internal / test accounts",
    description: "Enable the HISTORICAL_PARTIAL_MATCH UI contract (Section 13) for a small, explicitly-allowlisted set of internal/test accounts only.",
    rollbackTrigger: "Any confirmed false positive against known-independent internal test content; any identity-leakage or score-invariance violation (Section 14/15).",
  },
  {
    stage: 2,
    name: "Limited cohort",
    description: "Enable for a limited percentage of real accounts. Exact percentage/selection mechanism is UNRESOLVED — a product/business decision outside this specification's scope.",
    rollbackTrigger: "Any statistically-noticeable rise in generic-false-positive reports versus Stage 0's shadow-mode baseline rate; any regression in the acceptance-matrix test suite (Section 18); any bounded-runtime budget violation.",
  },
  {
    stage: 3,
    name: "Full activation",
    description: "Enable for all accounts.",
    rollbackTrigger: "Same criteria as Stage 2, monitored on an ongoing basis, not just at cutover.",
  },
];

// ============================================================================
// SECTION 17 — OBSERVABILITY PLAN
// ============================================================================

export const OBSERVABILITY_METRICS = [
  "historical_full_match_rate",
  "historical_partial_match_rate",
  "self_relationship_rate",
  "prior_submission_relationship_rate",
  "unknown_relationship_rate",
  "candidate_count_per_submission",
  "passage_count_per_partial_match",
  "e8m_correspondence_runtime_ms",
  "v2_distinctiveness_runtime_ms",
  "recomputation_rate", // how often a resubmission/re-view triggers re-matching vs a cached result
  "reported_generic_false_positive_count", // user/reviewer-reported, not automatically inferred
] as const;

export const OBSERVABILITY_CONSTRAINT =
  "None of the above metrics may include document content, passage text, or account identity — counts, rates, and timings only, mirroring the same discipline already enforced structurally throughout E8B-E8N (see e.g. tests/e8k-passage-evaluator.test.mjs's own 'no content in diagnostics logging' pattern).";
