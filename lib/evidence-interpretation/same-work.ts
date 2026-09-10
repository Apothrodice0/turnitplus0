import type { ReportHistoricalSubmissionMatch } from "@/lib/report-types";
import type { SameWorkRelationship } from "./kinds";

/**
 * PHASE 2 (hardened) — map an EXISTING historical/prior-submission signal to a
 * SameWorkRelationship, and ONLY when a trusted signal EXPLICITLY states a
 * work/version relationship that is INDEPENDENT of textual-similarity strength.
 *
 * ── Why this returns null in V1 ──────────────────────────────────────────
 *
 * The current data model contains NO such independent signal. Every path that
 * produces a historical match's `relationshipType` / `matchType` is derived
 * from account identity and/or text-match strength:
 *
 *   - `relationshipType` (lib/user-submission-matching.ts, lib/document-relationship.ts):
 *       SELF            = summarizeSubmissionOwnership.hasSameAccountSubmission
 *                         (the SAME ACCOUNT — possibly Device-Passport-derived —
 *                          submitted a document that matched this text)
 *       PRIOR_SUBMISSION = another account submitted matching text earlier
 *       Both are ACCOUNT-IDENTITY classifications, not a version relation.
 *       lib/document-relationship.ts's own header: "account identity determines
 *       SELF vs PRIOR_SUBMISSION"; "VERIFIED_SOURCE is not implemented anywhere".
 *
 *   - `matchType` (EXACT_CANONICAL_MATCH | STRONG_TEXT_MATCH):
 *       EXACT_CANONICAL_MATCH = canonical TEXT equality (containment 1)
 *       STRONG_TEXT_MATCH     = a measured containment
 *       Both are SIMILARITY STRENGTH, not a relationship.
 *
 *   - document families (lib/document-family.ts): membership is decided by
 *       "share enough distinctive text to be the same underlying work" —
 *       FamilyMatchType is again SEED | EXACT_CANONICAL_MATCH | STRONG_TEXT_MATCH.
 *       There is no explicit "version-of" / "prior-version" edge.
 *
 *   - owner-link (lib/owner-link.ts): not on main, migration 0042 not applied,
 *       and it links an owner to a pseudonym (identity), not a work to a version.
 *
 * So NONE of: STRONG_TEXT_MATCH, similarity %, exact text equality alone, a
 * Device Passport match, same account, same device, a SELF classification (which
 * may be Passport-derived), or "PRIOR_SUBMISSION because the matched object is an
 * earlier submission" qualifies. Per the hardening rule, `sameWorkRelationship`
 * is `null` for historical-submission evidence, and POSSIBLE_SAME_WORK is
 * INTENTIONALLY DORMANT for that producer in V1. This is acceptable — no new
 * heuristic is invented.
 *
 * ── What would make it non-null ─────────────────────────────────────────
 *
 * An explicit, independently-produced work/version link, e.g.:
 *   - a `document_versions` / prior-version edge asserting "B is version N of A",
 *   - an owner-link (or equivalent) VERSION relationship, once such a thing
 *     exists and is applied to `main`,
 *   - trusted same-work metadata attached by a subsystem that is not the text
 *     matcher.
 * When one appears, THIS function reads it and returns the matching
 * SameWorkRelationship. The interpreter's POSSIBLE_SAME_WORK path already exists
 * and is unit-tested with a direct `sameWorkRelationship` input — only the
 * mapping from today's fields is neutralised here.
 */
export function mapHistoricalMatchToSameWorkRelationship(
  _hist: ReportHistoricalSubmissionMatch | null | undefined,
): SameWorkRelationship | null {
  // V1: no independent work/version relationship signal exists in the data
  // model. relationshipType is account-identity-derived; matchType is
  // similarity strength. Neither is a version relation -> null.
  return null;
}

/**
 * The interpretation layer's POSSIBLE_SAME_WORK is dormant for historical /
 * prior-submission evidence in V1 because no independent work/version
 * relationship signal exists (see mapHistoricalMatchToSameWorkRelationship).
 */
export const SAME_WORK_RELATIONSHIP_DORMANT_FOR_HISTORICAL_EVIDENCE_V1 = true;
