/**
 * Manual account activation — the plan rules shared by the server (lib/account-entitlements.ts,
 * lib/account-activation-admin.ts), the admin console and the customer's account page. Isomorphic on purpose: no
 * database or Node imports, so the browser shows exactly the rules the server applies.
 *
 * A plan is what the owner grants after arranging payment directly with the customer (no payment provider exists in
 * this product): a duration and a number of rooms. "Rooms" are the product's existing room slots (lib/report-rooms.ts):
 * each numbered room holds one report and becomes available again 24 h after its upload, so a plan of N rooms lets the
 * customer upload into rooms 1..N, each on its own 24 h cooldown, until the plan expires. Rooms are not consumed.
 */

/** The only durations the owner sells. Never a calendar month: a plan lasts exactly this many 24 h days. */
export const PLAN_DURATION_DAYS = [30, 90, 180, 360] as const;
export type PlanDurationDays = (typeof PLAN_DURATION_DAYS)[number];

export const MIN_PLAN_ROOMS = 1;
/** Upper bound the owner chose for a plan's room count (each room is a slot the room list renders). */
export const MAX_PLAN_ROOMS = 100;

export const DAY_MS = 24 * 60 * 60 * 1000;

export function isPlanDurationDays(value: unknown): value is PlanDurationDays {
  return typeof value === "number" && (PLAN_DURATION_DAYS as readonly number[]).includes(value);
}

export function isValidPlanRooms(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PLAN_ROOMS && value <= MAX_PLAN_ROOMS;
}

/** `days` whole days after `fromMs`, in UTC milliseconds. */
export function planEndsAt(fromMs: number, days: PlanDurationDays): number {
  return fromMs + days * DAY_MS;
}

/**
 * Renewal policy (explicit, tested): a renewal of a plan that has not expired yet starts when the current one ends, so
 * the customer never loses paid days; a plan that has already expired starts again now (that is an activation, not a
 * renewal — see lib/account-activation-admin.ts).
 */
export function renewalStartsAt(currentExpiresAtMs: number, nowMs: number): number {
  return Math.max(currentExpiresAtMs, nowMs);
}

export type EntitlementStatus = "active" | "suspended";

/** The stored plan, as both the server and the browser see it (timestamps in UTC milliseconds). */
export type Entitlement = {
  status: EntitlementStatus;
  planDays: PlanDurationDays;
  rooms: number;
  activatedAt: number;
  expiresAt: number;
  suspendedAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
};

/** What a plan means right now. "expired" wins over "suspended": an expired plan can only be activated again. */
export type PlanState = "none" | "active" | "suspended" | "expired";

export function planStateOf(entitlement: Entitlement | null, nowMs: number): PlanState {
  if (!entitlement) return "none";
  if (entitlement.expiresAt <= nowMs) return "expired";
  return entitlement.status === "suspended" ? "suspended" : "active";
}

/** Machine codes a refused new check carries (POST /api/reports answers 403 with one of these). */
export type PlanBlockCode = "ACTIVATION_REQUIRED" | "PLAN_EXPIRED" | "ACCOUNT_SUSPENDED" | "ROOM_NOT_IN_PLAN" | "ACTIVATION_UNAVAILABLE";

export function isPlanBlockCode(value: unknown): value is PlanBlockCode {
  return (
    value === "ACTIVATION_REQUIRED" ||
    value === "PLAN_EXPIRED" ||
    value === "ACCOUNT_SUSPENDED" ||
    value === "ROOM_NOT_IN_PLAN" ||
    value === "ACTIVATION_UNAVAILABLE"
  );
}

/** "24 January 2027" — the account page's date style, always rendered in UTC so every viewer sees the same day. */
export function formatPlanDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** "24 January 2027, 14:05 UTC" — for the admin console, where the exact moment matters. */
export function formatPlanDateTime(ms: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${formatPlanDate(ms)}, ${time} UTC`;
}

/** The customer-facing sentence for a refused new check. */
export function planBlockMessage(code: PlanBlockCode, entitlement: Entitlement | null): string {
  switch (code) {
    case "ACTIVATION_REQUIRED":
      return "Your account is not activated yet. Contact TurnitPlus to activate a plan, then start your check.";
    case "PLAN_EXPIRED":
      return `Your plan expired on ${entitlement ? formatPlanDate(entitlement.expiresAt) : "its end date"}. Contact TurnitPlus to renew it. Your existing reports stay available.`;
    case "ACCOUNT_SUSPENDED":
      return "Your plan is paused. Contact TurnitPlus to restore it. Your existing reports stay available.";
    case "ROOM_NOT_IN_PLAN":
      return `This room is not part of your plan${entitlement ? ` (rooms 1–${entitlement.rooms})` : ""}. Choose one of your plan's rooms.`;
    case "ACTIVATION_UNAVAILABLE":
      return "New checks are temporarily unavailable. Please try again later.";
  }
}
