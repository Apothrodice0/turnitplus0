import {
  SCORING_IGNORABLE_FORMAT_RANGES,
  hasScoringIgnorableFormatCharacter,
  tokensForScoringNormalization,
  type ScoringNormalizationVersion,
} from "./similarity-core";

/**
 * Which scoring-normalization contract a DISCOVERY / INDEX ARTIFACT may be
 * read under.
 *
 * A report is computed natively under its own contract (its persisted
 * scoringNormalizationVersion; lib/scoring-normalization-scope.ts), and every
 * verifier re-tokenizes source text under that contract. Discovery artifacts
 * — Archive fingerprints / DF bands / FTS phrase index / co-source graph,
 * prior-submission shingles, the Selective Corpus packed index — are instead
 * built once, outside any scope, under the contract active at build time, and
 * none of them records it. Without a rule, a report stamped v1 would find its
 * candidates through an artifact built under v2 (or the reverse) and still
 * look like an exact historical replay.
 *
 * THE RULE. An artifact may be read under contract C only when its identity
 * is compatible with C:
 *   - BUILT_UNDER v      — recorded or proven build contract; compatible iff v === C.
 *   - CONTRACT_INDEPENDENT — proven to be byte-identical under every contract;
 *                          compatible with any C.
 *   - UNKNOWN            — no record and no proof; compatible with nothing.
 * An incompatible artifact is never read silently: the lane reports it
 * (ArtifactNormalizationIncompatibleError, ARTIFACT_UNAVAILABLE, or a partial
 * result) instead of returning a completed result. Never guessed from file
 * names or timestamps.
 *
 * THE PROOF. An artifact is a function of the token streams of its documents
 * (tokens() of the source text). v1 and v2 differ only in deleting
 * SCORING_IGNORABLE_FORMAT_RANGES code points, so a document whose v1 and v2
 * token streams are identical (scoringContractsAgreeOnText) yields identical
 * artifact entries under both, and an artifact whose every document agrees is
 * CONTRACT_INDEPENDENT. A text without any of those code points always agrees
 * (lower(NFKD(c)) never yields one for any other code point — exhaustively
 * tested), so only the rare text holding one is tokenized twice. A document
 * whose streams differ ("contract-dependent") must have its build contract
 * proven (its stored entries equal the entries derived under exactly one
 * contract) or recorded; otherwise the artifact is UNKNOWN.
 */
export const SCORING_NORMALIZATION_ARTIFACT_POLICY_VERSION = "scoring-normalization-artifact-policy-v1";

export type ArtifactNormalizationIdentity =
  | { kind: "BUILT_UNDER"; version: ScoringNormalizationVersion; proof: string }
  | { kind: "CONTRACT_INDEPENDENT"; proof: string }
  | { kind: "UNKNOWN"; reason: string };

export type ArtifactNormalizationCompatibility =
  | { compatible: true; basis: "SAME_CONTRACT" | "CONTRACT_INDEPENDENT" }
  | { compatible: false; reason: "CONTRACT_MISMATCH" | "UNKNOWN_CONTRACT"; detail: string };

export function artifactNormalizationCompatibility(
  reportVersion: ScoringNormalizationVersion,
  identity: ArtifactNormalizationIdentity,
): ArtifactNormalizationCompatibility {
  if (identity.kind === "CONTRACT_INDEPENDENT") return { compatible: true, basis: "CONTRACT_INDEPENDENT" };
  if (identity.kind === "BUILT_UNDER") {
    return identity.version === reportVersion
      ? { compatible: true, basis: "SAME_CONTRACT" }
      : { compatible: false, reason: "CONTRACT_MISMATCH", detail: `built under scoring normalization v${identity.version}, read under v${reportVersion}` };
  }
  return { compatible: false, reason: "UNKNOWN_CONTRACT", detail: identity.reason };
}

/** Whether `text` tokenizes identically under every scoring-normalization
 *  contract — the per-document proof (see THE PROOF above). */
export function scoringContractsAgreeOnText(text: string): boolean {
  if (!hasScoringIgnorableFormatCharacter(text)) return true;
  const v1 = tokensForScoringNormalization(text, 1);
  const v2 = tokensForScoringNormalization(text, 2);
  return v1.length === v2.length && v1.every((word, index) => word === v2[index]);
}

/** SQLite GLOB pattern matching any text that holds a
 *  SCORING_IGNORABLE_FORMAT_RANGES code point (libsql's GLOB compares UTF-8
 *  code points, astral ranges included) — narrows a corpus to the texts that
 *  need scoringContractsAgreeOnText before any text leaves the database. */
export const SCORING_IGNORABLE_TEXT_GLOB = `*[${SCORING_IGNORABLE_FORMAT_RANGES
  .map(([first, last]) => (first === last ? String.fromCodePoint(first) : `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`))
  .join("")}]*`;

/** An artifact family refused under the report's contract. */
export class ArtifactNormalizationIncompatibleError extends Error {
  readonly code = "ARTIFACT_NORMALIZATION_INCOMPATIBLE";
  constructor(
    readonly artifactFamily: string,
    readonly reportVersion: ScoringNormalizationVersion,
    readonly compatibility: Extract<ArtifactNormalizationCompatibility, { compatible: false }>,
  ) {
    super(`${artifactFamily} cannot be read under scoring normalization v${reportVersion}: ${compatibility.reason} (${compatibility.detail})`);
    this.name = "ArtifactNormalizationIncompatibleError";
  }
}
