"use client";

import { useEffect, useState } from "react";
import type { CustomerPlanView } from "@/lib/account-entitlements";
import { formatPlanDate } from "@/lib/account-plan";

/**
 * The account page's "Subscription" panel (manual subscriptions). Reads GET /api/account/plan — the server's view of
 * THIS session's own plan — and renders nothing at all while the feature is off or for an exempt (administrator)
 * account, so the page is then exactly what it was before. Display only; the server enforces.
 *
 * Owner decision 2026-10-30: one simple status panel in the account page's own type scale — a title and a status pill,
 * then plain text at the page's one body size (labels and values alike). Not active / expired / paused: two short
 * lines (what it means, who to contact). Active: two detail rows (rooms, valid until).
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

/** True when this plan view means the account may open no report (no subscription, expired, paused). */
export function planBlocksReports(plan: PlanResponse | null): boolean {
  return !!plan && plan.authenticated && plan.enforced && !plan.exempt && plan.graceEndsAt === null && (plan.state === "none" || plan.state === "expired" || plan.state === "suspended");
}

const STATE_LABEL: Record<string, string> = {
  active: "Active",
  expired: "Expired",
  suspended: "Paused",
  none: "Not active",
  unavailable: "Unavailable",
};

function inactiveLines(state: string, expiresAt: number | null, message: string | null): [string, string] | [string] {
  switch (state) {
    case "none":
      return ["An active subscription is required to check documents.", "Contact TurnitPlus to activate your plan."];
    case "expired":
      return [expiresAt !== null ? `Your subscription ended on ${formatPlanDate(expiresAt)}.` : "Your subscription has ended.", "Contact TurnitPlus to renew your plan."];
    case "suspended":
      return ["Your subscription is paused.", "Contact TurnitPlus to restore your plan."];
    default:
      return [message ?? "New checks are temporarily unavailable."];
  }
}

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
  // An existing account in its legacy free-access period keeps the old free limits; the message gives the end date.
  const inGrace = plan.graceEndsAt !== null;
  const label = inGrace ? "Free access" : STATE_LABEL[state] ?? state;
  return (
    <section className={`account-subscription account-subscription-${inGrace ? "active" : state}`} aria-labelledby="account-subscription-title">
      <div className="account-subscription-head">
        <h3 id="account-subscription-title">Subscription</h3>
        <span className={`account-subscription-status account-subscription-status-${inGrace ? "active" : state}`}>{label}</span>
      </div>
      {state === "active" && !inGrace ? (
        <>
          <dl className="account-subscription-details">
            <div>
              <dt>Rooms</dt>
              <dd>{plan.rooms ? `${plan.rooms.available} of ${plan.rooms.allocated} available` : "—"}</dd>
            </div>
            {plan.expiresAt !== null && (
              <div>
                <dt>Valid until</dt>
                <dd>{formatPlanDate(plan.expiresAt)}</dd>
              </div>
            )}
          </dl>
          {plan.rooms && plan.rooms.cooling > 0 && (
            <p className="account-subscription-text">Each room is available again 24 hours after its upload.</p>
          )}
        </>
      ) : inGrace ? (
        plan.message && <p className="account-subscription-text">{plan.message}</p>
      ) : (
        inactiveLines(state, plan.expiresAt, plan.message).map((line) => (
          <p key={line} className="account-subscription-text">{line}</p>
        ))
      )}
    </section>
  );
}
