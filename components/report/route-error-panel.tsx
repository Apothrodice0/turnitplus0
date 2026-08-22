"use client";

import Link from "next/link";

/**
 * Shared fallback for app/reports/[id]/error.tsx and
 * app/reports/rooms/[room]/error.tsx (production audit fix — this app had
 * no error.tsx anywhere, so an uncaught exception during render — a
 * transient DB connectivity blip, most realistically — fell through to
 * Next's generic unstyled crash page instead of the app's own visual
 * language). Mirrors report-not-found-panel.tsx's markup/classes (already
 * reused for the P0 rate-limited states in the sibling page.tsx files) so
 * this reads as one more expected state of the same views, not a different
 * product. `reset` is Next's own retry affordance — appropriate here
 * specifically because the most likely real trigger (a transient DB error)
 * is retry-shaped; a report whose own data is corrupt is handled upstream
 * as a normal not-found instead of ever reaching this boundary.
 */
export function RouteErrorPanel({ reset, message }: { reset: () => void; message: string }) {
  return (
    <div className="result-view report-detail-page">
      <div className="report-not-found-wrap">
        <section className="ai-analysis-message">
          <strong>—</strong>
          <div>
            <p>{message}</p>
            <button className="button primary" type="button" onClick={reset}>
              Try again
            </button>{" "}
            <Link href="/#reports" className="button secondary">
              Back to my reports
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
