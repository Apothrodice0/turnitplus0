import type { ReactNode } from "react";

/** Grid of at-a-glance stat tiles — replaces a wall of <li>Label: value</li> text. */
export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="admin-metric-grid">{children}</div>;
}

export function MetricTile({
  label,
  value,
  sub,
}: {
  label: string;
  /** A plain value, or a small inline element (e.g. an AdminStatusBadge) for an enum-shaped metric. */
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="admin-metric-tile">
      <div className="admin-metric-tile-label">{label}</div>
      <div className="admin-metric-tile-value">{value}</div>
      {sub && <div className="admin-metric-tile-sub">{sub}</div>}
    </div>
  );
}
