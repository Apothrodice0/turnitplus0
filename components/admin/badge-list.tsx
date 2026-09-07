/** Renders a `{ key: count }` distribution as compact badge chips instead of a comma-joined sentence. */
export function DistributionBadges({ distribution }: { distribution: Record<string, number> }) {
  const entries = Object.entries(distribution);
  if (entries.length === 0) return <span className="admin-badge">none</span>;
  return (
    <div className="admin-badge-list">
      {entries.map(([key, count]) => (
        <span key={key} className="admin-badge">
          {key}: <strong>{count}</strong>
        </span>
      ))}
    </div>
  );
}

/** A labeled group of distribution badges — label above, badges below. */
export function BadgeGroup({ label, distribution }: { label: string; distribution: Record<string, number> }) {
  return (
    <div className="admin-badge-group">
      <p className="admin-badge-group-label">{label}</p>
      <DistributionBadges distribution={distribution} />
    </div>
  );
}
