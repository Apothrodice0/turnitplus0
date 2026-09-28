import type { ArchiveExplorerCardMetrics } from "./archive-types";
import { formatCompactCount, formatCount } from "./archive-format";

/**
 * The four live figures on the /admin launcher's Archive card. Values come
 * from getArchiveExplorerCardMetrics (the same derivation as /admin/archive's
 * own tiles); nothing here computes or defaults a number. When the figures
 * could not be loaded the card says so instead of showing zeros.
 */
export function ArchiveCardMetrics({ metrics }: { metrics: ArchiveExplorerCardMetrics | null }) {
  if (!metrics) {
    return <p className="admin-archive-card-unavailable">Live figures are temporarily unavailable.</p>;
  }
  return (
    <dl className="admin-archive-card-metrics">
      <Figure label="Active" value={metrics.active} emphasis />
      <Figure label="This week" value={metrics.addedLast7Days} signed />
      <Figure label="Maturing" value={metrics.maturing} />
      <Figure label="Rejected · 7d" value={metrics.rejectedOrDuplicateLast7Days} />
    </dl>
  );
}

function Figure({ label, value, signed = false, emphasis = false }: { label: string; value: number; signed?: boolean; emphasis?: boolean }) {
  const text = `${signed && value > 0 ? "+" : ""}${formatCompactCount(value)}`;
  return (
    <div className={emphasis ? "is-emphasis" : undefined}>
      <dt>{label}</dt>
      <dd title={formatCount(value)}>{text}</dd>
    </div>
  );
}
