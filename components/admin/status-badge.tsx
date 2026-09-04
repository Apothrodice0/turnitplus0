type BadgeVariant = "positive" | "negative" | "warning" | "info" | "neutral";

// Presentational mapping only — every key here is an existing status/decision
// string already produced by lib/corpus-admission-admin-repo.ts or
// lib/corpus-admission-sweep-state.ts. Adding a color mapping introduces no
// new status, and an unmapped value safely falls back to "neutral" rather
// than throwing.
const VARIANT_BY_VALUE: Record<string, BadgeVariant> = {
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
};

/** Small colored pill for a status/decision value — purely presentational, reused across the admin console. */
export function AdminStatusBadge({ status, label }: { status: string; label?: string }) {
  const variant = VARIANT_BY_VALUE[status] ?? "neutral";
  return <span className={`admin-status-badge admin-status-badge--${variant}`}>{label ?? status}</span>;
}
