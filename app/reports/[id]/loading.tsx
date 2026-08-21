export default function ReportLoading() {
  return (
    <main className="result-view report-detail-page" aria-live="polite" aria-busy="true">
      <header className="result-toolbar">
        <div className="back-button" aria-hidden="true">← Back to reports</div>
        <div className="result-document">
          <div className="history-file-icon" aria-hidden="true">T+</div>
          <div>
            <h1>Opening report…</h1>
            <p>Loading this report room and its saved evidence.</p>
          </div>
        </div>
      </header>
      <div className="report-not-found-wrap">
        <section className="ai-analysis-loading" role="status">
          <span aria-hidden="true" />
          <div>
            <strong>Opening report…</strong>
            <p>Your report is being loaded. You do not need to wait for your other reports.</p>
          </div>
        </section>
      </div>
    </main>
  );
}
