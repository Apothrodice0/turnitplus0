"use client";

import { useEffect, useState } from "react";
import { CalendarClock, DoorOpen } from "lucide-react";
import type { CustomerPlanView } from "@/lib/account-entitlements";
import { formatPlanDate } from "@/lib/account-plan";

/**
 * The account page's "Your plan" card (manual account activation). Reads GET /api/account/plan — the server's view of
 * THIS session's own plan — and renders nothing at all while the feature is off or for an exempt (administrator)
 * account, so the page is then exactly what it was before. Display only; POST /api/reports enforces.
 */

type PlanResponse = ({ authenticated: true } & CustomerPlanView) | { authenticated: false };

export async function fetchAccountPlan(): Promise<PlanResponse | null> {
  try {
    const response = await fetch("/api/account/plan", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as PlanResponse;
  } catch {
    return null;
  }
}

const STATE_LABEL: Record<string, string> = {
  active: "Active",
  expired: "Expired",
  suspended: "Paused",
  none: "Not activated",
  unavailable: "Unavailable",
};

export function AccountPlanCard() {
  const [plan, setPlan] = useState<PlanResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAccountPlan().then((result) => {
      if (!cancelled) setPlan(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!plan || !plan.authenticated || !plan.enforced || plan.exempt) return null;

  const state = plan.state;
  return (
    <section className={`account-plan-card account-plan-${state}`} aria-labelledby="account-plan-title">
      <div className="account-plan-head">
        <h3 id="account-plan-title">Your plan</h3>
        <span className={`account-plan-status account-plan-status-${state}`}>{STATE_LABEL[state] ?? state}</span>
      </div>
      {plan.planDays !== null && plan.expiresAt !== null ? (
        <dl className="account-plan-grid">
          <div>
            <dt>Plan</dt>
            <dd>{plan.planDays} days</dd>
          </div>
          <div>
            <dt><DoorOpen aria-hidden="true" /> Rooms</dt>
            <dd>
              {plan.rooms
                ? state === "active"
                  ? `${plan.rooms.available} available now of ${plan.rooms.allocated}`
                  : `${plan.rooms.allocated} allocated`
                : "—"}
            </dd>
          </div>
          <div>
            <dt><CalendarClock aria-hidden="true" /> {state === "expired" ? "Expired" : "Expires"}</dt>
            <dd>{formatPlanDate(plan.expiresAt)}</dd>
          </div>
          {plan.activatedAt !== null && (
            <div>
              <dt>Activated</dt>
              <dd>{formatPlanDate(plan.activatedAt)}</dd>
            </div>
          )}
        </dl>
      ) : null}
      {state === "active" && plan.rooms && plan.rooms.cooling > 0 && (
        <p className="account-plan-note">
          Each room is available again 24 hours after its upload — {plan.rooms.cooling} of your rooms {plan.rooms.cooling === 1 ? "is" : "are"} in use right now.
        </p>
      )}
      {plan.message && <p className="account-plan-message">{plan.message}</p>}
    </section>
  );
}
