"use client";

import { useState } from "react";
import type { ArchiveExplorerGrowthDay } from "./archive-types";
import { formatCount, formatDay } from "./archive-format";

/** Clean y-axis top: 2, 4, 6, 8, 10 × 10^n at or above the max — even, so the midline tick is a whole count too. */
function niceCeiling(value: number): number {
  if (value <= 2) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [2, 4, 6, 8, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * Admission intake per UTC day for the last 30 days: stored admissions vs.
 * evaluations that were not stored (duplicate / rejected / review). Bulk
 * reference-archive and legacy additions are listed in the tooltip and the
 * table view rather than plotted — a one-off seed of hundreds of reference
 * sources would flatten every admission column to nothing.
 */
export function ArchiveGrowthChart({ growth }: { growth: ArchiveExplorerGrowthDay[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const totals = growth.map((d) => ({ stored: d.accepted, notStored: d.duplicate + d.rejected + d.review }));
  const max = niceCeiling(Math.max(0, ...totals.map((t) => t.stored + t.notStored)));
  const sum = growth.reduce(
    (acc, d) => ({
      accepted: acc.accepted + d.accepted,
      notStored: acc.notStored + d.duplicate + d.rejected + d.review,
      reference: acc.reference + d.referenceAdded,
      legacy: acc.legacy + d.legacyAdded,
    }),
    { accepted: 0, notStored: 0, reference: 0, legacy: 0 },
  );
  const activeDays = growth.filter((d) => d.accepted + d.duplicate + d.rejected + d.review + d.referenceAdded + d.legacyAdded > 0);
  const hoveredDay = hovered === null ? null : growth[hovered];

  return (
    <div className="admin-archive-chart">
      <div className="admin-archive-chart-head">
        <ul className="admin-archive-legend admin-archive-legend--inline">
          <li><span className="admin-archive-key admin-archive-key--submissions" aria-hidden="true" /><span>Stored admissions</span><strong>{formatCount(sum.accepted)}</strong></li>
          <li><span className="admin-archive-key admin-archive-key--not-stored" aria-hidden="true" /><span>Not stored</span><strong>{formatCount(sum.notStored)}</strong></li>
        </ul>
        <span className="admin-archive-chart-note">
          + {formatCount(sum.reference)} reference · {formatCount(sum.legacy)} legacy added (not plotted)
        </span>
      </div>

      {activeDays.length === 0 ? (
        <p className="admin-corpus-empty">No corpus intake in the last 30 days.</p>
      ) : (
        <div className="admin-archive-chart-plot" onMouseLeave={() => setHovered(null)}>
          <div className="admin-archive-chart-grid" aria-hidden="true">
            <span style={{ bottom: "100%" }}><em>{formatCount(max)}</em></span>
            <span style={{ bottom: "50%" }}><em>{formatCount(max / 2)}</em></span>
            <span style={{ bottom: "0%" }}><em>0</em></span>
          </div>
          <div className="admin-archive-chart-columns">
            {growth.map((day, index) => {
              const { stored, notStored } = totals[index];
              const label = `${formatDay(day.day)}: ${stored} stored, ${notStored} not stored`;
              return (
                <button
                  key={day.day}
                  type="button"
                  className={`admin-archive-chart-col${hovered === index ? " is-hovered" : ""}`}
                  aria-label={label}
                  onMouseEnter={() => setHovered(index)}
                  onFocus={() => setHovered(index)}
                  onBlur={() => setHovered(null)}
                >
                  <span className="admin-archive-chart-stack">
                    {stored > 0 && <span className="admin-archive-chart-seg admin-archive-chart-seg--submissions" style={{ height: `${(stored / max) * 100}%` }} />}
                    {notStored > 0 && <span className="admin-archive-chart-seg admin-archive-chart-seg--not-stored" style={{ height: `${(notStored / max) * 100}%` }} />}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="admin-archive-chart-axis" aria-hidden="true">
            <span>{formatDay(growth[0].day)}</span>
            <span>{formatDay(growth[Math.floor(growth.length / 2)].day)}</span>
            <span>{formatDay(growth[growth.length - 1].day)}</span>
          </div>
          {hoveredDay && hovered !== null && (
            <div
              className="admin-archive-chart-tooltip"
              role="status"
              style={{ left: `${((hovered + 0.5) / growth.length) * 100}%` }}
              data-side={hovered >= growth.length / 2 ? "left" : "right"}
            >
              <div className="admin-archive-chart-tooltip-day">{formatDay(hoveredDay.day)}</div>
              <TooltipRow tone="submissions" label="Stored admissions" value={hoveredDay.accepted} />
              <TooltipRow tone="not-stored" label="Duplicate" value={hoveredDay.duplicate} />
              <TooltipRow tone="not-stored" label="Rejected" value={hoveredDay.rejected} />
              <TooltipRow tone="not-stored" label="Review" value={hoveredDay.review} />
              {hoveredDay.referenceAdded > 0 && <TooltipRow tone="reference" label="Reference added" value={hoveredDay.referenceAdded} />}
              {hoveredDay.legacyAdded > 0 && <TooltipRow tone="plain" label="Legacy added" value={hoveredDay.legacyAdded} />}
            </div>
          )}
        </div>
      )}

      {activeDays.length > 0 && (
        <details className="admin-archive-chart-table">
          <summary>View as table</summary>
          <div className="admin-table-scroll">
            <table className="developer-table admin-archive-compact-table">
              <thead>
                <tr><th>Day (UTC)</th><th>Stored</th><th>Duplicate</th><th>Rejected</th><th>Review</th><th>Reference added</th><th>Legacy added</th></tr>
              </thead>
              <tbody>
                {[...activeDays].reverse().map((d) => (
                  <tr key={d.day}>
                    <td>{formatDay(d.day)}</td>
                    <td>{formatCount(d.accepted)}</td>
                    <td>{formatCount(d.duplicate)}</td>
                    <td>{formatCount(d.rejected)}</td>
                    <td>{formatCount(d.review)}</td>
                    <td>{formatCount(d.referenceAdded)}</td>
                    <td>{formatCount(d.legacyAdded)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function TooltipRow({ tone, label, value }: { tone: "submissions" | "not-stored" | "reference" | "plain"; label: string; value: number }) {
  return (
    <div className="admin-archive-chart-tooltip-row">
      <span className={`admin-archive-line-key admin-archive-line-key--${tone}`} aria-hidden="true" />
      <strong>{formatCount(value)}</strong>
      <span>{label}</span>
    </div>
  );
}
