import Link from "next/link";

export function ReportNotFoundPanel() {
  return (
    <section className="ai-analysis-message">
      <strong>—</strong>
      <div>
        <p>This report could not be found. It may have been deleted, or it may only be available on the device and browser it was created in.</p>
        <Link href="/#reports" className="button primary">Back to my reports</Link>
      </div>
    </section>
  );
}
