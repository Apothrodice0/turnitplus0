import Link from "next/link";

/**
 * R2 — the customer-facing state for a saved report whose stored explanation
 * cannot be decoded safely (see lib/report-persistence.ts's
 * tryDecodeReportFromPersistence). Deliberately generic: no version, format,
 * table, index or field names, and no similarity number — the row is not shown at
 * all rather than shown as a score without its cards and highlights. Mirrors
 * report-not-found-panel.tsx's markup/classes so it reads as one more expected
 * state of the same views. Not "not found": the report exists, and the owner is
 * told so.
 */
export function ReportUnavailablePanel({ backHref = "/#reports", backLabel = "Back to my reports" }: { backHref?: string; backLabel?: string }) {
  return (
    <section className="ai-analysis-message" role="status">
      <strong>—</strong>
      <div>
        <p>This report is temporarily unavailable. Please try again in a few minutes, and contact support if it is still unavailable.</p>
        <Link href={backHref} className="button primary">{backLabel}</Link>
      </div>
    </section>
  );
}
