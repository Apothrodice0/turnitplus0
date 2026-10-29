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

/**
 * Plan duration (owner decision 2026-10-28): any whole number of days from MIN_PLAN_DAYS to MAX_PLAN_DAYS, with the
 * console offering PLAN_DURATION_PRESETS. Never a calendar month: a plan lasts exactly this many 24 h days. The same
 * bounds are a CHECK constraint on account_entitlements.plan_days (drizzle/0057).
 */
export const MIN_PLAN_DAYS = 1;
export const MAX_PLAN_DAYS = 3650;
export const PLAN_DURATION_PRESETS = [30, 60, 90, 180, 360] as const;
export type PlanDurationDays = number;

export const MIN_PLAN_ROOMS = 1;
/** Upper bound the owner chose for a plan's room count (each room is a slot the room list renders). */
export const MAX_PLAN_ROOMS = 100;
/** Room counts the console offers as one-click presets; any whole number in range can be typed. */
export const PLAN_ROOM_PRESETS = [5, 10, 20, 40] as const;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Legacy free access — RETIRED (owner decision 2026-10-29: no free checking for any customer account once
 * enforcement is on). The logic is kept behind ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED, which is OFF unless that
 * variable is explicitly "1"/"true"; with it off, accounts registered before enforcement get no free access either.
 * When enabled, accounts registered before enforcement first switched on would keep the free limits (10 rooms, 10
 * uploads per UTC day) for this many days after that moment (account_activation_enforcement, drizzle/0057).
 */
export const LEGACY_GRACE_DAYS = 30;

/** The subscription-required wording (owner decision 2026-10-29), shown on the locked upload area and in refusals. */
export const SUBSCRIPTION_REQUIRED_TITLE = "Subscription required";
export const SUBSCRIPTION_REQUIRED_MESSAGE = "You need an active subscription before you can check documents.";
export const SUBSCRIPTION_CONTACT_MESSAGE = "Please contact TurnitPlus to activate your plan.";

export function isPlanDurationDays(value: unknown): value is PlanDurationDays {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PLAN_DAYS && value <= MAX_PLAN_DAYS;
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
      return `${SUBSCRIPTION_REQUIRED_MESSAGE} ${SUBSCRIPTION_CONTACT_MESSAGE}`;
    case "PLAN_EXPIRED":
      return `Your subscription expired on ${entitlement ? formatPlanDate(entitlement.expiresAt) : "its end date"}. ${SUBSCRIPTION_REQUIRED_MESSAGE} Please contact TurnitPlus to renew your plan. Your existing reports stay available.`;
    case "ACCOUNT_SUSPENDED":
      return `Your subscription is paused. ${SUBSCRIPTION_REQUIRED_MESSAGE} Please contact TurnitPlus to restore your plan. Your existing reports stay available.`;
    case "ROOM_NOT_IN_PLAN":
      return `This room is not part of your plan${entitlement ? ` (rooms 1–${entitlement.rooms})` : ""}. Choose one of your plan's rooms.`;
    case "ACTIVATION_UNAVAILABLE":
      return "New checks are temporarily unavailable. Please try again later.";
  }
}

/** Whether a refusal is about the account's subscription (locked upload area) rather than one room (cooldown, outside the plan). */
export function isSubscriptionBlock(code: PlanBlockCode): boolean {
  return code === "ACTIVATION_REQUIRED" || code === "PLAN_EXPIRED" || code === "ACCOUNT_SUSPENDED" || code === "ACTIVATION_UNAVAILABLE";
}

/** What the locked upload area shows (components/reports/document-upload-panel.tsx `locked`). */
export type UploadLock = {
  title: string;
  message: string;
  /** A second line, e.g. "Please contact TurnitPlus to activate your plan." */
  contact: string | null;
  /** A short status line, e.g. when the subscription expired. */
  detail: string | null;
  /** The disabled action button's label. */
  actionLabel: string;
};

/**
 * The locked upload area for a refused new check — the same wording on the dashboard and in every room. `expiresAt`
 * is the plan's end, for an expired plan's status line.
 */
export function uploadLockFor(code: PlanBlockCode, expiresAt: number | null, rooms: number | null = null): UploadLock {
  switch (code) {
    case "ACTIVATION_REQUIRED":
      return { title: SUBSCRIPTION_REQUIRED_TITLE, message: SUBSCRIPTION_REQUIRED_MESSAGE, contact: SUBSCRIPTION_CONTACT_MESSAGE, detail: null, actionLabel: SUBSCRIPTION_REQUIRED_TITLE };
    case "PLAN_EXPIRED":
      return {
        title: SUBSCRIPTION_REQUIRED_TITLE,
        message: SUBSCRIPTION_REQUIRED_MESSAGE,
        contact: "Please contact TurnitPlus to renew your plan.",
        detail: `Your subscription expired on ${expiresAt !== null ? formatPlanDate(expiresAt) : "its end date"} · your reports stay available`,
        actionLabel: SUBSCRIPTION_REQUIRED_TITLE,
      };
    case "ACCOUNT_SUSPENDED":
      return {
        title: SUBSCRIPTION_REQUIRED_TITLE,
        message: SUBSCRIPTION_REQUIRED_MESSAGE,
        contact: "Please contact TurnitPlus to restore your plan.",
        detail: "Your subscription is paused · your reports stay available",
        actionLabel: SUBSCRIPTION_REQUIRED_TITLE,
      };
    case "ACTIVATION_UNAVAILABLE":
      return { title: "New checks unavailable", message: "New checks are temporarily unavailable.", contact: "Please try again later.", detail: null, actionLabel: "Unavailable" };
    case "ROOM_NOT_IN_PLAN":
      return {
        title: "Room not in your plan",
        message: `This room is not part of your plan${rooms !== null ? ` (rooms 1–${rooms})` : ""}.`,
        contact: "Choose one of your plan's rooms from My Reports.",
        detail: null,
        actionLabel: "Room unavailable",
      };
  }
}

/** The locked upload area for an empty room still in its 24 h cooldown (server clock). */
export function roomCooldownLock(roomNumber: number, availableAt: number): UploadLock {
  return {
    title: "Room cooling down",
    message: `Room ${roomNumber} accepts a new check again at ${formatPlanDateTime(availableAt)}.`,
    contact: "Each room takes one document every 24 hours.",
    detail: null,
    actionLabel: "Room unavailable",
  };
}

/** The account's plan state, as GET /api/account/plan reports it, to the refusal code a new check would get. */
export function planStateBlockCode(state: PlanState | "unavailable"): PlanBlockCode | null {
  if (state === "active") return null;
  if (state === "none") return "ACTIVATION_REQUIRED";
  if (state === "expired") return "PLAN_EXPIRED";
  if (state === "suspended") return "ACCOUNT_SUSPENDED";
  return "ACTIVATION_UNAVAILABLE";
}

/** The customer-facing sentence while an existing account is in its legacy free-access period (only if re-enabled). */
export function legacyGraceMessage(endsAt: number): string {
  return `Your free access (10 rooms, 10 uploads per day) continues until ${formatPlanDate(endsAt)}. Contact TurnitPlus to activate a plan before then.`;
}
