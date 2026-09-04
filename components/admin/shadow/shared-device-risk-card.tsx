import type { SharedDeviceRiskMeasurement } from "@/lib/device-sharedness-measurement";
import { MetricGrid, MetricTile } from "@/components/admin/metric-tile";
import { BadgeGroup } from "@/components/admin/badge-list";
import { AdminCollapsible } from "@/components/admin/collapsible";

/**
 * Shared-device false-SELF risk — same data as the former
 * app/developer/page.tsx inline section, reorganized into summary metric
 * tiles + collapsible policy-impact/detail table. Measurement and
 * hypothetical-policy evidence only; no score or relationship is changed.
 */
export function SharedDeviceRiskCard({ measurement }: { measurement: SharedDeviceRiskMeasurement }) {
  const m = measurement;
  return (
    <section className="admin-card">
      <h2>Shared-device false-SELF risk</h2>
      <p>
        <span className="admin-workspace-badge">{m.policyVersion}</span>{" "}
        Same browser / profile ≠ automatically same human. For every current same-device SELF downgrade candidate,
        how shared its verified upload Passport looks.
      </p>

      <MetricGrid>
        <MetricTile
          label="Candidates evaluated"
          value={m.totals.candidatesEvaluated}
          sub={m.totals.candidatesCapped > 0 ? `${m.totals.candidatesCapped} capped` : undefined}
        />
        <MetricTile label="Distinct candidate devices" value={m.distinctCandidateDevices} />
        <MetricTile label="On devices with anon. uploads" value={m.candidatesOnDevicesWithAnonUploads} />
        <MetricTile label="Pair shares exactly 1 Passport" value={m.pairSharesExactlyOnePassport} />
        <MetricTile label="Pair shares 2+ Passports" value={m.pairSharesTwoOrMorePassports} />
        <MetricTile label="Devices, exactly 1 pair" value={m.devicesWithExactlyOnePair} />
        <MetricTile label="Devices, multiple pairs" value={m.devicesWithMultiplePairs} />
        <MetricTile label="Devices, no resolvable pair" value={m.devicesWithNoResolvablePair} />
      </MetricGrid>

      <AdminCollapsible summary="Distributions & data gaps">
        <BadgeGroup label="Device account-count buckets" distribution={m.deviceAccountCountBuckets} />
        <BadgeGroup label="Risk category" distribution={m.riskCategoryDistribution} />
        <BadgeGroup
          label="Data gaps"
          distribution={{
            "missing report row": m.totals.candidatesMissingReportRow,
            "missing passport": m.totals.candidatesMissingPassport,
            "missing snapshot": m.totals.candidatesMissingSnapshot,
            "representation drift": m.totals.candidatesRepresentationDrift,
            "source account unresolved": m.totals.candidatesSourceAccountUnresolved,
            "anonymous target": m.totals.candidatesTargetAnonymous,
          }}
        />
      </AdminCollapsible>

      <AdminCollapsible summary="Hypothetical policy impact">
        <div className="admin-table-scroll">
          <table className="developer-table">
            <thead>
              <tr>
                <th>Hypothetical policy</th>
                <th>Kept as SELF</th>
                <th>Blocked</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>CURRENT_PREVIEW (A)</td><td>{m.policyImpact.CURRENT_PREVIEW.kept}</td><td>{m.policyImpact.CURRENT_PREVIEW.blocked}</td></tr>
              <tr><td>TWO_ACCOUNT_MAX (B)</td><td>{m.policyImpact.TWO_ACCOUNT_MAX.kept}</td><td>{m.policyImpact.TWO_ACCOUNT_MAX.blocked}</td></tr>
              <tr><td>MULTI_PASSPORT_PAIR (C)</td><td>{m.policyImpact.MULTI_PASSPORT_PAIR.kept}</td><td>{m.policyImpact.MULTI_PASSPORT_PAIR.blocked}</td></tr>
              <tr><td>CONSERVATIVE_COMBINED (D)</td><td>{m.policyImpact.CONSERVATIVE_COMBINED.kept}</td><td>{m.policyImpact.CONSERVATIVE_COMBINED.blocked}</td></tr>
            </tbody>
          </table>
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
                <th>Device accounts</th>
                <th>Device submissions</th>
                <th>Device anon</th>
                <th>Unordered pairs</th>
                <th>Pair shared Passports</th>
                <th>Pair other Passports</th>
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
                  <td>{row.productionRelationship ?? "—"}</td>
                  <td>{row.proposedRelationship ?? "—"}</td>
                  <td>{row.exactCanonical === null ? "?" : row.exactCanonical ? "yes" : "no"}</td>
                  <td>{row.sameVerifiedDevice === null ? "?" : row.sameVerifiedDevice ? "yes" : "no"}</td>
                  <td>{row.independentBackingCount ?? "?"}</td>
                  <td>{row.deviceDistinctAccounts ?? "?"}</td>
                  <td>{row.deviceSubmissionCount ?? "?"}</td>
                  <td>{row.deviceAnonUploads ?? "?"}</td>
                  <td>{row.unorderedDeviceAccountPairCount ?? "?"}</td>
                  <td>{row.pairSharedPassportCount ?? "?"}</td>
                  <td>{row.pairOtherVerifiedPassportCount ?? "?"}</td>
                  <td>{row.policyA ? "keep" : "block"}</td>
                  <td>{row.policyB ? "keep" : "block"}</td>
                  <td>{row.policyC ? "keep" : "block"}</td>
                  <td>{row.policyD ? "keep" : "block"}</td>
                  <td title={row.riskRationale}>{row.riskCategory}</td>
                </tr>
              ))}
              {m.recentCandidates.length === 0 && (
                <tr>
                  <td colSpan={17}>No current same-device SELF downgrade candidates.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCollapsible>
    </section>
  );
}
