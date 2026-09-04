import Link from "next/link";
import type { DeviceProvenanceShadowMeasurement } from "@/lib/device-provenance-shadow-measurement";
import { MetricGrid, MetricTile } from "@/components/admin/metric-tile";
import { BadgeGroup } from "@/components/admin/badge-list";
import { AdminCollapsible } from "@/components/admin/collapsible";

/**
 * Device Passport shadow measurement — same data as the former
 * app/developer/page.tsx inline section, reorganized into summary metric
 * tiles + collapsible distributions/table. Telemetry only; no score or
 * relationship is changed by this policy.
 */
export function DeviceProvenanceShadowCard({ measurement }: { measurement: DeviceProvenanceShadowMeasurement }) {
  const m = measurement;
  return (
    <section className="admin-card">
      <h2>Device Passport shadow measurement</h2>
      <p>
        <span className="admin-workspace-badge">{m.policyVersion}</span>{" "}
        Proposed same-device SELF rule, telemetry only. No score or relationship is changed by this policy today.
      </p>

      <MetricGrid>
        <MetricTile label="Evaluations" value={m.totals.evaluations} sub={`${m.totals.ok} OK · ${m.totals.failed} failed · ${m.totals.unparseableEvidence} unparseable`} />
        <MetricTile label="Matched / no match" value={`${m.totals.matched} / ${m.totals.noHistoricalMatch}`} />
        <MetricTile label="Would downgrade" value={m.wouldDowngradeCount} sub="≥1 counted match → SELF" />
        <MetricTile label="Same-device exact doc." value={m.sameDeviceExactDocumentCount} />
        <MetricTile label="Shared-device evaluations" value={m.sharedDeviceEvaluationCount} />
        <MetricTile label="Blocked by indep. backing" value={m.blockedByIndependentBackingCount} />
        <MetricTile label="Candidate indep. backing > 0" value={m.candidateIndependentBackingPositiveCount} />
        <MetricTile label="Exact same-device, not downgraded" value={m.exactSameDeviceNotDowngraded.total} />
      </MetricGrid>

      <AdminCollapsible summary="Distributions">
        <BadgeGroup label="deviceDistinctAccounts" distribution={m.deviceDistinctAccountsDistribution} />
        <BadgeGroup label="deviceSubmissionCount" distribution={m.deviceSubmissionCountDistribution} />
        <BadgeGroup label="Production relationships" distribution={m.productionRelationshipDistribution} />
        <BadgeGroup label="Proposed relationships" distribution={m.proposedRelationshipDistribution} />
        <BadgeGroup label="Agreement" distribution={m.agreementDistribution} />
        <BadgeGroup label="Exact same-device, not downgraded — by candidate reason" distribution={m.exactSameDeviceNotDowngraded.byCandidateReason} />
      </AdminCollapsible>

      <AdminCollapsible summary={`Recent candidates (${m.recentCandidates.length})`}>
        <div className="admin-table-scroll">
          <table className="developer-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Production rel.</th>
                <th>Proposed rel.</th>
                <th>Downgrade?</th>
                <th>Reason</th>
                <th>Exact canon.</th>
                <th>Same device</th>
                <th>Indep. backings</th>
                <th>Device accounts</th>
                <th>Device submissions</th>
                <th>Computed</th>
              </tr>
            </thead>
            <tbody>
              {m.recentCandidates.map((row) => (
                <tr key={`${row.reportDeviceKey}:${row.reportId}`}>
                  <td>
                    <Link href={`/admin/developer/reports/${encodeURIComponent(row.reportId)}?deviceKey=${encodeURIComponent(row.reportDeviceKey)}`}>
                      {row.reportId}
                    </Link>
                  </td>
                  <td>{row.productionRelationship ?? "—"}</td>
                  <td>{row.proposedRelationship ?? "—"}</td>
                  <td>{row.wouldDowngrade === null ? "?" : row.wouldDowngrade ? "yes" : "no"}</td>
                  <td>{row.reason ?? "—"}</td>
                  <td>{row.exactCanonical === null ? "?" : row.exactCanonical ? "yes" : "no"}</td>
                  <td>{row.sameVerifiedDevice === null ? "?" : row.sameVerifiedDevice ? "yes" : "no"}</td>
                  <td>{row.independentBackingCount ?? "?"}</td>
                  <td>{row.sharedDeviceAccountCount ?? "?"}</td>
                  <td>{row.sharedDeviceSubmissionCount ?? "?"}</td>
                  <td>{row.computedAt}</td>
                </tr>
              ))}
              {m.recentCandidates.length === 0 && (
                <tr>
                  <td colSpan={11}>No device-provenance shadow evaluations yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCollapsible>
    </section>
  );
}
