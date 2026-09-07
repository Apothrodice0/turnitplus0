import type { ReactNode } from "react";

/** Grid of at-a-glance stat tiles — replaces a wall of <li>Label: value</li> text. */
export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="admin-metric-grid">{children}</div>;
}

export function MetricTile({
  label,
  value,
  sub,
  variant = "numeric",
}: {
  label: string;
  /** A plain value, or a small inline element (e.g. an AdminStatusBadge) for an enum-shaped metric. */
  value: ReactNode;
  sub?: ReactNode;
  /**
   * "numeric" (default) keeps the existing large bold treatment — right for
   * a count, a percentage, a short fixed word ("Enabled"/"—"). Pass "text"
   * for a value that may be a long machine-readable enum/status string (e.g.
   * a raw academicEvidenceStatus) — it renders smaller and wraps/breaks
   * cleanly instead of overflowing the tile. Reach for an AdminStatusBadge
   * as `value` first when the string is a short, known enum; use "text" for
   * an unbounded or free-form one.
   */
  variant?: "numeric" | "text";
}) {
  return (
    <div className="admin-metric-tile">
      <div className="admin-metric-tile-label">{label}</div>
      <div className={variant === "text" ? "admin-metric-tile-value admin-metric-tile-value--text" : "admin-metric-tile-value"}>{value}</div>
      {sub && <div className="admin-metric-tile-sub">{sub}</div>}
    </div>
  );
}
