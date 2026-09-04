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
