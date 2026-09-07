import type { SharedDeviceRiskMeasurement } from "@/lib/device-sharedness-measurement";
import { MetricGrid, MetricTile } from "@/components/admin/metric-tile";
import { BadgeGroup, DistributionBadges } from "@/components/admin/badge-list";
import { AdminCollapsible } from "@/components/admin/collapsible";
import { AdminStatusBadge, YesNoBadge } from "@/components/admin/status-badge";

const POLICY_LABELS: Record<"CURRENT_PREVIEW" | "TWO_ACCOUNT_MAX" | "MULTI_PASSPORT_PAIR" | "CONSERVATIVE_COMBINED", string> = {
  CURRENT_PREVIEW: "CURRENT_PREVIEW (A)",
  TWO_ACCOUNT_MAX: "TWO_ACCOUNT_MAX (B)",
  MULTI_PASSPORT_PAIR: "MULTI_PASSPORT_PAIR (C)",
  CONSERVATIVE_COMBINED: "CONSERVATIVE_COMBINED (D)",
};
const POLICY_ORDER = ["CURRENT_PREVIEW", "TWO_ACCOUNT_MAX", "MULTI_PASSPORT_PAIR", "CONSERVATIVE_COMBINED"] as const;

/** Compact per-row data-quality flags — only ever shown when at least one is true, so a clean row stays a plain "—". */
function DataGapBadges({ drift, unresolved, anonymous }: { drift: boolean; unresolved: boolean; anonymous: boolean }) {
  if (!drift && !unresolved && !anonymous) return <>—</>;
  return (
    <span className="admin-badge-list">
      {drift && <span className="admin-status-badge admin-status-badge--warning">drift</span>}
      {unresolved && <span className="admin-status-badge admin-status-badge--warning">unresolved</span>}
      {anonymous && <span className="admin-status-badge admin-status-badge--neutral">anon target</span>}
    </span>
  );
}

/**
 * Shared-device false-SELF risk — summary metric tiles + a visible
 * risk-category distribution + a policy-impact comparison as compact cards +
 * collapsible detail table. Measurement and hypothetical-policy evidence
 * only; no score or relationship is changed. Risk category strings are
 * rendered exactly as lib/device-sharedness-risk.ts returns them (only the
 * badge color is presentational).
 *
 * Admin Phase 2B finding: the recentCandidates row's own
 * `deviceDistinctAccountsAtShadow` field — the module's own header comment
 * calls this out as existing specifically "so drift is visible" against the
 * live `deviceDistinctAccounts` recount — was fetched but never shown next
 * to it. `representationDrift` / `sourceAccountUnresolved` / `targetAnonymous`
 * were likewise computed per-row but only ever surfaced as aggregate totals.
 * All four are now visible per row via the two new table columns below.
 */
export function SharedDeviceRiskCard({ measurement }: { measurement: SharedDeviceRiskMeasurement }) {
  const m = measurement;
  const multiAccountDevices = m.deviceAccountCountBuckets.two + m.deviceAccountCountBuckets.threePlus;

  return (
    <section className="admin-card">
      <h2>Shared-device false-SELF risk</h2>
      <p className="admin-card-description">
        <span className="admin-workspace-badge">{m.policyVersion}</span>{" "}
        Same browser / profile ≠ automatically same human. For every current same-device SELF downgrade candidate,
        how shared its verified upload Passport looks.
      </p>

      <MetricGrid>
        <MetricTile
          label="Evaluated candidates"
          value={m.totals.candidatesEvaluated}
          sub={m.totals.candidatesCapped > 0 ? `${m.totals.candidatesCapped} capped` : undefined}
        />
        <MetricTile label="Distinct candidate devices" value={m.distinctCandidateDevices} />
        <MetricTile label="One-account devices" value={m.deviceAccountCountBuckets.one} />
        <MetricTile label="Multi-account devices" value={multiAccountDevices} sub={`2: ${m.deviceAccountCountBuckets.two} · 3+: ${m.deviceAccountCountBuckets.threePlus}`} />
        <MetricTile label="Unknown account count" value={m.deviceAccountCountBuckets.unknown} />
        <MetricTile label="On devices with anon. uploads" value={m.candidatesOnDevicesWithAnonUploads} />
        <MetricTile label="Pairs, single shared Passport" value={m.pairSharesExactlyOnePassport} sub="weakest evidence" />
        <MetricTile label="Pairs, 2+ shared Passports" value={m.pairSharesTwoOrMorePassports} sub="strongest evidence" />
      </MetricGrid>

      <div className="admin-badge-group">
        <p className="admin-badge-group-label">Risk category distribution</p>
        <div className="admin-badge-list">
          {Object.entries(m.riskCategoryDistribution).map(([category, count]) => (
            <span key={category} className="admin-status-badge-count">
              <AdminStatusBadge status={category} /> <strong>{count}</strong>
            </span>
          ))}
        </div>
      </div>

      <h3>Hypothetical policy impact</h3>
      <div className="admin-policy-grid">
        {POLICY_ORDER.map((policy) => (
          <div key={policy} className="admin-policy-card">
            <div className="admin-policy-card-name">{POLICY_LABELS[policy]}</div>
            <div className="admin-policy-card-stats">
              <span className="admin-status-badge admin-status-badge--positive">{m.policyImpact[policy].kept} kept</span>
              <span className="admin-status-badge admin-status-badge--negative">{m.policyImpact[policy].blocked} blocked</span>
            </div>
          </div>
        ))}
      </div>

      <AdminCollapsible summary="Device pairing & data gaps">
        <BadgeGroup label="Devices by candidate-pair count" distribution={{ "exactly 1 pair": m.devicesWithExactlyOnePair, "multiple pairs": m.devicesWithMultiplePairs, "no resolvable pair": m.devicesWithNoResolvablePair }} />
        <div className="admin-badge-group">
          <p className="admin-badge-group-label">Data gaps</p>
          <DistributionBadges
            distribution={{
              "missing report row": m.totals.candidatesMissingReportRow,
              "missing passport": m.totals.candidatesMissingPassport,
              "missing snapshot": m.totals.candidatesMissingSnapshot,
              "representation drift": m.totals.candidatesRepresentationDrift,
              "source account unresolved": m.totals.candidatesSourceAccountUnresolved,
              "anonymous target": m.totals.candidatesTargetAnonymous,
              "pair-Passport count unknown": m.pairSharedPassportUnknown,
            }}
          />
        </div>
      </AdminCollapsible>

      <AdminCollapsible summary={`Recent candidates (${m.recentCandidates.length})`}>
        <div className="admin-table-scroll">
          <table className="developer-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Prod. rel.</th>
                <th>Proposed SELF</th>
                <th>Exact canon.</th>
                <th>Same device</th>
                <th>Indep. backing</th>
                <th>Device accounts (live)</th>
                <th>Device accounts (@shadow)</th>
                <th>Device submissions</th>
                <th>Device anon</th>
                <th>Unordered pairs</th>
                <th>Pair shared Passports</th>
                <th>Pair other Passports</th>
                <th>Data gaps</th>
                <th>A</th>
                <th>B</th>
                <th>C</th>
                <th>D</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {m.recentCandidates.map((row) => (
                <tr key={row.reportId}>
                  <td>{row.reportId}</td>
                  <td>{row.productionRelationship ? <AdminStatusBadge status={row.productionRelationship} /> : "—"}</td>
                  <td>{row.proposedRelationship ? <AdminStatusBadge status={row.proposedRelationship} /> : "—"}</td>
                  <td><YesNoBadge value={row.exactCanonical} /></td>
                  <td><YesNoBadge value={row.sameVerifiedDevice} /></td>
                  <td>{row.independentBackingCount ?? "?"}</td>
                  <td>{row.deviceDistinctAccounts ?? "?"}</td>
                  <td className={row.deviceDistinctAccountsAtShadow !== row.deviceDistinctAccounts ? "admin-table-drift" : undefined}>
                    {row.deviceDistinctAccountsAtShadow ?? "?"}
                  </td>
                  <td>{row.deviceSubmissionCount ?? "?"}</td>
                  <td>{row.deviceAnonUploads ?? "?"}</td>
                  <td>{row.unorderedDeviceAccountPairCount ?? "?"}</td>
                  <td>{row.pairSharedPassportCount ?? "?"}</td>
                  <td>{row.pairOtherVerifiedPassportCount ?? "?"}</td>
                  <td><DataGapBadges drift={row.representationDrift} unresolved={row.sourceAccountUnresolved} anonymous={row.targetAnonymous} /></td>
                  <td>{row.policyA ? "keep" : "block"}</td>
                  <td>{row.policyB ? "keep" : "block"}</td>
                  <td>{row.policyC ? "keep" : "block"}</td>
                  <td>{row.policyD ? "keep" : "block"}</td>
                  <td title={row.riskRationale}><AdminStatusBadge status={row.riskCategory} label={row.riskCategory} /></td>
                </tr>
              ))}
              {m.recentCandidates.length === 0 && (
                <tr>
                  <td colSpan={19}>No current same-device SELF downgrade candidates.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCollapsible>
    </section>
  );
}
