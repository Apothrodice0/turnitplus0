import type { ArchiveExplorerActivityKind, ArchiveExplorerSourceClass, ArchiveExplorerState } from "./archive-types";

// Presentation vocabulary for the admin Archive explorer. Literals, not
// imports from lib/corpus-admission-archive-explorer.ts (a server module) —
// the `satisfies` clauses make a drift from the server's own unions a type
// error rather than a silent mismatch.

export const SOURCE_CLASS_OPTIONS = ["reference_archive", "admitted_submission", "legacy_submission"] as const satisfies readonly ArchiveExplorerSourceClass[];
export const STATE_OPTIONS = ["active", "maturing", "stored", "removed", "review", "rejected", "duplicate"] as const satisfies readonly ArchiveExplorerState[];

export const SOURCE_CLASS_LABEL: Record<ArchiveExplorerSourceClass, string> = {
  reference_archive: "Reference archive",
  admitted_submission: "Admitted submission",
  legacy_submission: "Legacy submission",
};

export const SOURCE_CLASS_PLURAL: Record<ArchiveExplorerSourceClass, string> = {
  reference_archive: "Reference archive",
  admitted_submission: "Admitted submissions",
  legacy_submission: "Legacy submissions",
};

export const STATE_LABEL: Record<ArchiveExplorerState, string> = {
  active: "Eligible",
  maturing: "Maturing",
  stored: "Awaiting index",
  removed: "Removed",
  review: "Review",
  rejected: "Rejected",
  duplicate: "Duplicate",
};

/** Maps onto components/admin/status-badge.tsx's variants via a key it already knows. */
export const STATE_BADGE_KEY: Record<ArchiveExplorerState, string> = {
  active: "accepted",
  maturing: "pending",
  stored: "staged",
  removed: "cancelled",
  review: "review",
  rejected: "rejected",
  duplicate: "rejected",
};

export const ACTIVITY_LABEL: Record<ArchiveExplorerActivityKind, string> = {
  admitted: "Admitted · stored, maturing",
  duplicate: "Rejected as duplicate",
  rejected: "Rejected",
  review: "Held for review",
  matured: "Maturity window elapsed",
  indexed: "Indexed into matching corpus",
  removed: "Removed from corpus",
  reference_added: "Reference sources added",
  legacy_added: "Legacy submissions indexed",
};

const DATE_TIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const DATE_ONLY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const DAY_SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Fixed UTC formatting — identical on the server and in the browser, so hydration never diverges. */
export function formatDateTime(iso: string | null): string {
  return iso ? `${DATE_TIME.format(new Date(iso))} UTC` : "—";
}

export function formatDate(iso: string | null): string {
  return iso ? DATE_ONLY.format(new Date(iso)) : "—";
}

export function formatDay(day: string): string {
  return DAY_SHORT.format(new Date(`${day}T00:00:00Z`));
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "—";
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Stat-tile figure for tight spaces: exact below 10,000 (9,999), compact above (12.3K / 1.2M) — never wider than ~6 glyphs. */
export function formatCompactCount(value: number): string {
  return Math.abs(value) < 10_000 ? value.toLocaleString("en-US") : COMPACT.format(value);
}

/** "3h ago" relative to a fixed reference instant (the summary's generatedAt), never the client clock. */
export function formatRelative(iso: string, referenceIso: string): string {
  const diffMs = new Date(referenceIso).getTime() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return formatDate(iso);
}
