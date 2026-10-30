import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import type { SubscriptionNotice } from "@/lib/account-plan";

/**
 * Manual subscriptions — the ONE screen an account without an active subscription sees instead of its rooms: on My
 * Reports (components/reports/report-rooms.tsx, in place of the whole room list) and on any empty room opened directly
 * (app/reports/rooms/[room]/page.tsx) and report URL (app/reports/[id]/page.tsx). A single centered card; no room list,
 * no report link and no upload area (owner decision 2026-10-30: such an account has no report history). Presentational
 * only: no state, no data access — the server decides who sees it.
 */
export function SubscriptionRequiredState({
  notice,
  backHref = null,
}: {
  notice: SubscriptionNotice;
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
        {backHref && (
          <Link href={backHref} className="subscription-required-back">
            Back to My Reports
          </Link>
        )}
      </div>
    </section>
  );
}
