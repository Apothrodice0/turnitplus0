type BadgeVariant = "positive" | "negative" | "warning" | "info" | "neutral";

// Presentational mapping only — every key here is an existing status/decision/
// relationship/category string already produced by
// lib/corpus-admission-admin-repo.ts, lib/corpus-admission-sweep-state.ts,
// lib/device-provenance-shadow-measurement.ts, lib/device-sharedness-risk.ts,
// or lib/corpus-duplicate-suppression-shadow-measurement.ts. Adding a color
// mapping introduces no new status/label — an unmapped value safely falls
// back to "neutral" rather than throwing, so every current and future enum
// value from those modules renders correctly with no change here.
const VARIANT_BY_VALUE: Record<string, BadgeVariant> = {
  // Corpus admission (lib/corpus-admission-admin-repo.ts)
  accepted: "positive",
  ACCEPT: "positive",
  success: "positive",
  indexed: "positive",
  rejected: "negative",
  REJECT: "negative",
  failed: "negative",
  dead_lettered: "negative",
  review: "warning",
  REVIEW: "warning",
  staged: "warning",
  pending: "info",
  cancelled: "neutral",
  skipped: "neutral",

  // Device Passport shadow (lib/device-provenance-shadow-measurement.ts) and
  // corpus-duplicate suppression shadow both use UPPERCASE status enums
  // ("OK"/"FAILED"/"BOUNDED") — a distinct key set from corpus admission's
  // lowercase "failed"/"pending"/etc. above, so both must be mapped.
  SELF: "warning",
  TURNITPLUS_CORPUS_SOURCE: "positive",
  PRIOR_SUBMISSION: "positive",
  NO_MATCH_TO_EVALUATE: "neutral",
  OK: "positive",
  FAILED: "negative",
  AGREE: "positive",
  DISAGREE_DEVICE_SELF: "warning",

  // Shared-device false-SELF risk categories (lib/device-sharedness-risk.ts)
  // — PAIR_MULTI_PASSPORT is the strongest evidence the accounts are one
  // real operator (low false-SELF risk); SHARED_HIGH_FANOUT is the opposite.
  PERSONAL_LIKELY: "positive",
  SHARED_LOW_EVIDENCE: "info",
  SHARED_MULTI_ACCOUNT: "warning",
  SHARED_HIGH_FANOUT: "negative",
  PAIR_MULTI_PASSPORT: "positive",
  UNKNOWN: "neutral",

  // Corpus-duplicate suppression shadow (lib/corpus-duplicate-suppression-shadow-measurement.ts)
  BOUNDED: "warning",
  SKIPPED_NOT_MATCHED: "neutral",
  SKIPPED_NO_AUTHORITATIVE: "neutral",
  NOT_APPLICABLE: "neutral",

  // Similarity decision trace (lib/admin-similarity-decision-trace.ts) —
  // source relationships, match types, counted/exclusion reasons.
  "N/A": "neutral",
  UNKNOWN_RELATIONSHIP: "warning",
  EXACT_CANONICAL_MATCH: "positive",
  STRONG_TEXT_MATCH: "info",
  COUNTED_ARCHIVE_SOURCE: "positive",
  COUNTED_SCHOLARLY_SOURCE: "positive",
  COUNTED_PRIOR_SUBMISSION: "positive",
  COUNTED_CORPUS_SOURCE: "positive",
  EXCLUDED_SELF: "neutral",
  EXCLUDED_EFFECTIVE_DEVICE_SELF: "neutral",
  EXCLUDED_UNKNOWN_RELATIONSHIP: "neutral",
  EXCLUDED_DUPLICATE_WORD_POSITIONS: "neutral",
  NO_VERIFIED_CORRESPONDENCE: "neutral",

  // Refined CONSERVATIVE_COMBINED (Policy D) shared-device guard reason
  // (lib/device-shared-guard-policy.ts) — telemetry only, never a score veto.
  PAIR_OTHER_PASSPORT: "positive",
  LOW_RISK_SINGLE_PAIR: "positive",
  BLOCKED_ACCOUNT_FANOUT: "negative",
  BLOCKED_ANONYMOUS_USE: "negative",
  BLOCKED_MULTIPLE_PAIRS: "negative",
  BLOCKED_INCOMPLETE_ACTOR_HISTORY: "warning",
  BLOCKED_INSUFFICIENT_EVIDENCE: "warning",
  NOT_APPLIED: "neutral",

  // Score band (lib/report-types.ts) and academic-search run status.
  Low: "positive",
  Moderate: "warning",
  High: "negative",
  COMPLETE_WITH_MATCHES: "positive",
  COMPLETE_NO_MATCHES: "info",
};

/** Small colored pill for a status/decision/relationship value — purely presentational, reused across the admin console. Unmapped values fall back to a neutral pill with their own exact text, never invented. */
export function AdminStatusBadge({ status, label }: { status: string; label?: string }) {
  const variant = VARIANT_BY_VALUE[status] ?? "neutral";
  return <span className={`admin-status-badge admin-status-badge--${variant}`}>{label ?? status}</span>;
}

/** Small yes/no/unknown pill for a boolean-or-null diagnostic field (exact canonical, same device, ...). Neutral coloring — a boolean fact, not a judgment. */
export function YesNoBadge({ value }: { value: boolean | null }) {
  if (value === null) return <span className="admin-status-badge admin-status-badge--neutral">unknown</span>;
  return <span className={`admin-status-badge admin-status-badge--${value ? "info" : "neutral"}`}>{value ? "yes" : "no"}</span>;
}
