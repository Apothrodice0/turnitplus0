import type { Client } from "@libsql/client";
import { tokens } from "./similarity-core";
import { canonicalizeText } from "./canonical-text";
import { canonicalSha256, findPriorSubmissionsForAccount } from "./document-identity";
import {
  findCandidateCorpusRepresentations,
  findRepresentationById,
  summarizeSubmissionOwnership,
  corpusShingleHashes,
  type CandidateCorpusRepresentation,
} from "./user-submission-corpus";
import { USER_SUBMISSION_MATCH_THRESHOLDS } from "./user-submission-matching";
import { computeDocumentCorrespondence } from "./document-correspondence";
import { computeRobustCorrespondence, DEFAULT_ROBUST_CORRESPONDENCE_CONFIG } from "./e8m-robust-correspondence";
import { v2DistinctivenessFromCorrespondence } from "./e8n-pipeline-evaluator";
import { buildCorpusFrequencyIndex } from "./e8l-distinctiveness-v2";
import type { CorpusDocument } from "./e8l-calibration-corpus";
import {
  classifyHistoricalMatch,
  PROPOSED_ACCEPTANCE_THRESHOLDS,
  PROPOSED_ACCEPTANCE_POLICY_VERSION,
  UI_CONTRACT,
  type WholeDocumentSignal,
  type PassageLevelSignal,
  type HistoricalMatchClassification,
} from "./e8o-historical-match-policy";
import type { ExperimentalHistoricalMatchDisplay, HistoricalMatchPassage, ReportHistoricalSubmissionMatch } from "./report-types";

/**
 * Phase E8P.3: the FIRST user-visible surface for E8O's proposed policy —
 * STRICTLY GATED to an explicitly allowlisted internal/test account, off by
 * default, never touched by anything outside that allowlist.
 *
 * Gating mechanism (Section 1 of this phase's own task description): no
 * existing test-account flag or allowlist mechanism was found anywhere in
 * this codebase (checked db/schema.ts's users table — id/email/username/
 * password_hash/created_at/updated_at only — and grepped for ALLOWLIST/
 * INTERNAL_ACCOUNT/TEST_ACCOUNT/FEATURE_FLAG/is_test/isInternal patterns —
 * none exist). Per this phase's own explicit fallback ordering, this file
 * builds option C: an environment-variable-controlled allowlist of exact
 * account ids, read fresh from process.env on every check (never cached,
 * never hardcoded). E8P_VISIBILITY_ALLOWLIST unset or empty means the
 * allowlist is empty, which means isE8pVisibilityAllowlisted() returns
 * false for every account — this is simultaneously the "default OFF"
 * behavior (Section 10) and the production rollback switch (Section 11):
 * clearing this one environment variable in Vercel turns the experimental
 * UI off for everyone, with no code change, no matcher change, no database
 * change.
 *
 * Deliberately duplicates (does not refactor out of) lib/e8p-shadow-
 * evaluation.ts's own candidate-search/ownership-drop/E8M/V2 sequence,
 * even though the two are structurally identical. lib/e8p-shadow-
 * evaluation.ts is already deployed and already proven correct in
 * production (E8P/E8P.2) — this phase does not touch it, so as not to put
 * the already-working telemetry path at risk for the sake of a DRY
 * refactor. Both modules reuse the exact same underlying production/
 * experimental primitives (USER_SUBMISSION_MATCH_THRESHOLDS,
 * computeDocumentCorrespondence, computeRobustCorrespondence,
 * v2DistinctivenessFromCorrespondence, classifyHistoricalMatch) — nothing
 * about the correspondence/distinctiveness/decision LOGIC is duplicated,
 * only the glue that calls them in sequence.
 *
 * Reconstructs (never reads from a stored column, since none exist —
 * drizzle/0021_historical_match_shadow_evaluations.sql intentionally never
 * stored passages/matchedWordCount/containment/representation ids, since
 * Stage 0 was never meant to render anything) the same passage-level
 * evidence the shadow evaluation already decided on, purely for THIS
 * response's display — nothing here is persisted anywhere. See this
 * phase's own final report for why this is read as "don't add a
 * synchronous matching cost for the general population" rather than "never
 * compute anything for the one-account allowlist," given the hard
 * constraint (Section 15) against changing the schema to store display-
 * ready evidence instead.
 *
 * Only ever activates when production's OWN historicalSubmissionMatch.status
 * is NO_HISTORICAL_MATCH — never runs, and never returns non-null, when
 * production already found a real match, so this can never appear
 * alongside, compete with, or override lib/report-historical-match.ts's own
 * result. Never writes to historical_match_shadow_evaluations (already
 * written by the deferred shadow pass elsewhere) or
 * report_historical_match_snapshots (production's own table, untouched).
 */

function parseAllowlist(): Set<string> {
  const raw = process.env.E8P_VISIBILITY_ALLOWLIST;
  if (!raw) return new Set();
  return new Set(
    raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0),
  );
}

/** Re-parses the environment on every call (no module-level caching) so a Vercel env var change takes effect on the next request without a redeploy. */
export function isE8pVisibilityAllowlisted(accountId: string | null): boolean {
  if (accountId === null) return false;
  return parseAllowlist().has(accountId);
}

const RELATIONSHIP_COPY: Record<"SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP", string> = {
  SELF: "You previously submitted this content.",
  PRIOR_SUBMISSION: "This content was previously submitted to TurnitPlus.",
  UNKNOWN_RELATIONSHIP: "Related content was previously submitted to TurnitPlus, but ownership could not be determined for this submission.",
};
export function experimentalRelationshipCopy(relationship: "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP"): string {
  return RELATIONSHIP_COPY[relationship];
}

const PARTIAL_MATCH_DISCLAIMER = UI_CONTRACT.find((entry) => entry.status === "HISTORICAL_PARTIAL_MATCH")?.disclaimer
  ?? "This is historical submission evidence only, not a plagiarism verdict."; // defensive fallback only — UI_CONTRACT always has this entry, see tests/e8o-policy-spec.test.mjs's own K1

/**
 * Returns the experimental display value for an allowlisted account's own
 * report, or null whenever there is nothing experimental to show — which
 * includes every non-allowlisted account (checked first, before any other
 * work), every report where production already found a real match, and
 * every report where the proposed policy did not reach
 * HISTORICAL_PARTIAL_MATCH. Never throws past this function — a computation
 * failure here must never turn an otherwise-successful report load into an
 * error, exactly like historicalSubmissionMatch's own guarantee.
 */
export async function getExperimentalHistoricalMatchForDisplay(
  client: Client,
  params: { accountId: string | null; rawText: string; productionResult: ReportHistoricalSubmissionMatch | undefined },
): Promise<ExperimentalHistoricalMatchDisplay | null> {
  if (!isE8pVisibilityAllowlisted(params.accountId)) return null;
  if (!params.productionResult || params.productionResult.status !== "NO_HISTORICAL_MATCH") return null;

  try {
    const accountId = params.accountId as string; // isE8pVisibilityAllowlisted already proved this is non-null
    const canonicalText = canonicalizeText(params.rawText);
    const submittedWordCount = tokens(canonicalText).length;
    const correspondenceThresholds = USER_SUBMISSION_MATCH_THRESHOLDS.correspondence;

    const queryShingles = corpusShingleHashes(canonicalText, correspondenceThresholds.shingleSize);
    const rawCandidates: CandidateCorpusRepresentation[] = queryShingles.size === 0
      ? []
      : await findCandidateCorpusRepresentations(client, queryShingles, {
          fingerprintVersion: USER_SUBMISSION_MATCH_THRESHOLDS.fingerprintVersion,
          minSharedShingles: USER_SUBMISSION_MATCH_THRESHOLDS.candidateShingleThreshold,
          limit: USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidates,
        });
    if (rawCandidates.length === 0) return null;

    let documentIdentityId: string | null = null;
    const ownIdentities = await findPriorSubmissionsForAccount(client, accountId, canonicalSha256(params.rawText));
    documentIdentityId = ownIdentities.length > 0 ? ownIdentities[ownIdentities.length - 1].id : null;

    const survivors: { canonicalText: string; relationship: "SELF" | "PRIOR_SUBMISSION" | "UNKNOWN_RELATIONSHIP" }[] = [];
    for (const candidate of rawCandidates) {
      const representation = await findRepresentationById(client, candidate.representationId);
      if (!representation) continue;
      const ownership = await summarizeSubmissionOwnership(client, candidate.representationId, {
        accountId,
        excludeDocumentIdentityId: documentIdentityId,
      });
      if (!ownership.hasSameAccountSubmission && ownership.otherAccountSubmissionCount === 0) continue; // same self-reference drop as production/shadow — see lib/e8p-shadow-evaluation.ts's own comment
      const relationship = ownership.hasSameAccountSubmission ? "SELF" : "PRIOR_SUBMISSION";
      survivors.push({ canonicalText: representation.canonicalText, relationship });
    }

    if (submittedWordCount < PROPOSED_ACCEPTANCE_THRESHOLDS.minimumDocumentWordCountForPartialMatch.value) return null;

    let best: { classification: HistoricalMatchClassification; containment: number; passages: { submittedText: string; submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }[] } | null = null;

    for (const survivor of survivors) {
      const c = computeDocumentCorrespondence(canonicalText, survivor.canonicalText, correspondenceThresholds);
      const wholeDocument: WholeDocumentSignal = {
        exactCanonicalMatch: c.exactCanonicalMatch,
        meetsProductionThreshold: c.strongCorrespondence,
        containment: c.containment,
        matchedWordCount: c.matchedWordCount,
        longestMatchWords: c.longestMatchWords,
      };
      if (wholeDocument.exactCanonicalMatch || wholeDocument.meetsProductionThreshold) continue; // production would already show this — nothing experimental to add

      const otherDocs: CorpusDocument[] = survivors
        .filter((s) => s !== survivor)
        .map((s, i) => ({ id: `candidate-${i}`, label: "LIVE_CORPUS", canonicalText: s.canonicalText }));
      const freqIndex = buildCorpusFrequencyIndex(otherDocs);
      const e8m = computeRobustCorrespondence(canonicalText, survivor.canonicalText, DEFAULT_ROBUST_CORRESPONDENCE_CONFIG);
      const { distinctiveness } = v2DistinctivenessFromCorrespondence(canonicalText, survivor.canonicalText, e8m, freqIndex);

      const passageLevel: PassageLevelSignal = {
        matchedWordCount: e8m.matchedWordCount,
        longestMatchWords: e8m.longestMatchWords,
        longestSinglePassageWords: e8m.passages.reduce((max, p) => Math.max(max, p.matchedWordCount), 0),
        passageCount: e8m.passageCount,
        passageDensity: e8m.passageDensity,
        distinctivenessV2: distinctiveness,
      };
      const classification = classifyHistoricalMatch({
        wholeDocument,
        passageLevel,
        relationship: survivor.relationship,
        submittedWordCount,
        thresholds: PROPOSED_ACCEPTANCE_THRESHOLDS,
      });
      if (classification.status !== "HISTORICAL_PARTIAL_MATCH") continue;
      if (!best || e8m.matchedWordCount > best.classification.passageLevelSignal!.matchedWordCount) {
        // c.containment is V0's own whole-document containment for this same
        // candidate pair — real and meaningful (it's exactly why this stayed
        // below production's threshold), not passageDensity (a different
        // "how tightly matched words cluster" metric already on
        // PassageLevelSignal). "containment if available" per this phase's
        // own task description, section 8.
        best = { classification, containment: c.containment, passages: e8m.passages };
      }
    }

    if (!best) return null;

    const passages: HistoricalMatchPassage[] = best.passages
      .slice(0, USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.maxPassages)
      .map((p) => ({ submittedText: p.submittedText, submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, matchedWordCount: p.matchedWordCount }));

    return {
      status: "HISTORICAL_PARTIAL_MATCH",
      relationship: best.classification.relationship,
      evidence: best.classification.evidence,
      matchedWordCount: best.classification.passageLevelSignal!.matchedWordCount,
      containment: best.containment,
      passageCount: best.classification.passageLevelSignal!.passageCount,
      passages,
      disclaimer: PARTIAL_MATCH_DISCLAIMER,
    };
  } catch (error) {
    console.error("getExperimentalHistoricalMatchForDisplay failed (non-fatal):", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Re-exported so callers/tests can reference the exact policy version this display is derived from without importing lib/e8o-historical-match-policy.ts directly. */
export const E8P_VISIBILITY_POLICY_VERSION = PROPOSED_ACCEPTANCE_POLICY_VERSION;
