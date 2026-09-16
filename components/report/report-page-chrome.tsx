import type { SimilarityReport } from "@/lib/report-types";

/**
 * Report-redesign page-numbering fix: `page`/`total` describe this
 * document's own logical SECTION position (Similarity Overview / Manuscript
 * / Source Details — always known exactly at render time), never a physical
 * printed-page number, which this component has no way to know (a section's
 * content can span any number of real pages once printed). `total` is
 * omitted by AiReport (a single, self-contained section), which keeps its
 * existing plain "Page {page}" text unchanged. Every SimilarityReport
 * section passes it explicitly, rendering "Section {page} of {total}"
 * instead — never a number this component cannot actually guarantee.
 */
function PageLabel({ page, total, label }: { page: number; total?: number; label: string }) {
  return <span>{total ? `Section ${page} of ${total}` : `Page ${page}`} · {label}</span>;
}

export function ReportPageHeader({
  report,
  page,
  total,
  label,
}: {
  report: SimilarityReport;
  page: number;
  total?: number;
  label: string;
}) {
  return (
    <div className="paper-header">
      <div className="paper-brand">
        <strong>TurnitPlus</strong>
      </div>
      <PageLabel page={page} total={total} label={label} />
      <span className="paper-id">Submission ID&nbsp;&nbsp; {report.submissionId}</span>
    </div>
  );
}

export function ReportPageFooter({
  report,
  page,
  total,
  label,
}: {
  report: SimilarityReport;
  page: number;
  total?: number;
  label: string;
}) {
  return (
    <div className="paper-footer">
      <div className="paper-brand">
        <strong>TurnitPlus</strong>
      </div>
      <PageLabel page={page} total={total} label={label} />
      <span className="paper-id">Submission ID&nbsp;&nbsp; {report.submissionId}</span>
    </div>
  );
}
