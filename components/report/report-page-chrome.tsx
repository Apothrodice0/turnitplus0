import type { SimilarityReport } from "@/lib/report-types";

export function ReportPageHeader({
  report,
  page,
  label,
}: {
  report: SimilarityReport;
  page: number;
  label: string;
}) {
  return (
    <div className="paper-header">
      <div className="paper-brand">
        <span>T+</span>
        <strong>integrity</strong>
      </div>
      <span>Page {page} · {label}</span>
      <span className="paper-id">Submission ID&nbsp;&nbsp; {report.submissionId}</span>
    </div>
  );
}

export function ReportPageFooter({
  report,
  page,
  label,
}: {
  report: SimilarityReport;
  page: number;
  label: string;
}) {
  return (
    <div className="paper-footer">
      <div className="paper-brand">
        <span>T+</span>
        <strong>integrity</strong>
      </div>
      <span>Page {page} · {label}</span>
      <span className="paper-id">Submission ID&nbsp;&nbsp; {report.submissionId}</span>
    </div>
  );
}
