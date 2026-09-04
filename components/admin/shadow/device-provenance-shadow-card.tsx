import Link from "next/link";
import type { DeviceProvenanceShadowMeasurement } from "@/lib/device-provenance-shadow-measurement";
import { MetricGrid, MetricTile } from "@/components/admin/metric-tile";
import { BadgeGroup } from "@/components/admin/badge-list";
import { AdminCollapsible } from "@/components/admin/collapsible";
import { AdminStatusBadge, YesNoBadge } from "@/components/admin/status-badge";

/**
 * Device Passport shadow measurement — summary metric tiles + collapsible
 * distributions/table. Telemetry only; no score or relationship is changed
 * by this policy.
 *
 * Admin Phase 2B finding: `exactSameDeviceNotDowngraded.byReason` was already
 * computed by the measurement layer but never rendered anywhere (only its
 * sibling `byCandidateReason` was) — added below. Per-row `status` and
 * `agreement` were likewise fetched into every recentCandidates row but only
 * ever surfaced in aggregate form; both are now their own table columns.
 */
export function DeviceProvenanceShadowCard({ measurement }: { measurement: DeviceProvenanceShadowMeasurement }) {
  const m = measurement;
  return (
    <section className="admin-card">
      <h2>Device Passport shadow</h2>
      <p className="admin-card-description">
        <span className="admin-workspace-badge">{m.policyVersion}</span>{" "}
        Proposed same-device SELF rule, telemetry only. No score or relationship is changed by this policy today.
      </p>

      <MetricGrid>
        <MetricTile label="Evaluated" value={m.totals.evaluations} sub={`${m.totals.ok} OK · ${m.totals.failed} failed · ${m.totals.unparseableEvidence} unparseable`} />
        <MetricTile label="Matched / no historical match" value={`${m.totals.matched} / ${m.totals.noHistoricalMatch}`} />
        <MetricTile label="Would downgrade" value={m.wouldDowngradeCount} sub="≥1 counted match → SELF" />
        <MetricTile label="Same-device exact document" value={m.sameDeviceExactDocumentCount} />
        <MetricTile label="Shared-device evaluations" value={m.sharedDeviceEvaluationCount} />
        <MetricTile label="Blocked by indep. backing" value={m.blockedByIndependentBackingCount} />
        <MetricTile label="Candidate indep. backing > 0" value={m.candidateIndependentBackingPositiveCount} />
        <MetricTile label="Exact same-device, not downgraded" value={m.exactSameDeviceNotDowngraded.total} />
      </MetricGrid>

      <AdminCollapsible summary="Distributions">
        <BadgeGroup label="Independent-backing distribution (deviceDistinctAccounts)" distribution={m.deviceDistinctAccountsDistribution} />
        <BadgeGroup label="deviceSubmissionCount" distribution={m.deviceSubmissionCountDistribution} />
        <BadgeGroup label="Production relationships" distribution={m.productionRelationshipDistribution} />
        <BadgeGroup label="Proposed relationships" distribution={m.proposedRelationshipDistribution} />
        <BadgeGroup label="Agreement" distribution={m.agreementDistribution} />
        <BadgeGroup label="Exact same-device, not downgraded — by reason" distribution={m.exactSameDeviceNotDowngraded.byReason} />
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
                <th>Status</th>
                <th>Agreement</th>
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
                  <td>{row.productionRelationship ? <AdminStatusBadge status={row.productionRelationship} /> : "—"}</td>
                  <td>{row.proposedRelationship ? <AdminStatusBadge status={row.proposedRelationship} /> : "—"}</td>
                  <td><YesNoBadge value={row.wouldDowngrade} /></td>
                  <td>{row.reason ? <AdminStatusBadge status={row.reason} /> : "—"}</td>
                  <td><YesNoBadge value={row.exactCanonical} /></td>
                  <td><YesNoBadge value={row.sameVerifiedDevice} /></td>
                  <td>{row.independentBackingCount ?? "?"}</td>
                  <td>{row.sharedDeviceAccountCount ?? "?"}</td>
                  <td>{row.sharedDeviceSubmissionCount ?? "?"}</td>
                  <td><AdminStatusBadge status={row.status} /></td>
                  <td><AdminStatusBadge status={row.agreement} /></td>
                  <td>
                    {row.computedAt}
                    {row.createdAt !== row.computedAt && <div className="admin-table-subtext">first seen {row.createdAt}</div>}
                  </td>
                </tr>
              ))}
              {m.recentCandidates.length === 0 && (
                <tr>
                  <td colSpan={13}>No device-provenance shadow evaluations yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCollapsible>
    </section>
  );
}
