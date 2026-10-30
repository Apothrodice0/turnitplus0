import Link from "next/link";
import { ChevronRight, LockKeyhole } from "lucide-react";
import type { SubscriptionNotice } from "@/lib/account-plan";

/**
 * Manual subscriptions — the ONE screen an account without an active subscription sees instead of its rooms: on My
 * Reports (components/reports/report-rooms.tsx, in place of the whole room list) and on any empty room opened directly
 * (app/reports/rooms/[room]/page.tsx). A single centered card; no room list, no upload area, and no link that could start
 * a new check. Reports the account already has stay readable through `earlierReports` (each opens a room holding a
 * report, never an empty one). Presentational only: no state, no data access — the server decides who sees it.
 */
export function SubscriptionRequiredState({
  notice,
  earlierReports = [],
  backHref = null,
}: {
  notice: SubscriptionNotice;
  /** Rooms that still hold one of the account's reports — readable, never a new-check room. */
  earlierReports?: { href: string; label: string }[];
  /** On a room page: the way back to My Reports. The screen is then the whole page, so it is centered in the viewport. */
  backHref?: string | null;
}) {
  return (
    <section className={`subscription-required-stage${backHref ? " subscription-required-stage-page" : ""}`} role="status" aria-labelledby="subscription-required-title">
      <div className="subscription-required-card">
        <span className="subscription-required-halo" aria-hidden="true">
          <span className="subscription-required-icon">
            <LockKeyhole />
          </span>
        </span>
        <h2 id="subscription-required-title">{notice.title}</h2>
        <p className="subscription-required-message">{notice.message}</p>
        <p className="subscription-required-secondary">{notice.secondary}</p>
        {notice.detail && <p className="subscription-required-detail">{notice.detail}</p>}
        {earlierReports.length > 0 && (
          <nav className="subscription-required-history" aria-label="Your earlier reports">
            <span className="subscription-required-history-label">Your earlier reports</span>
            <ul>
              {earlierReports.map((report) => (
                <li key={report.href}>
                  <Link href={report.href} prefetch={false}>
                    <span>{report.label}</span>
                    <ChevronRight aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {backHref && (
          <Link href={backHref} className="subscription-required-back">
            Back to My Reports
          </Link>
        )}
      </div>
    </section>
  );
}
