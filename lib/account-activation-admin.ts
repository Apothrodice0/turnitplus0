import type { Client, Transaction } from "@libsql/client";
import type { SessionUser } from "./auth-session";
import { usersHaveEmailVerifiedAtColumn } from "./email-verification";
import {
  ENTITLEMENT_COLUMNS,
  entitlementFromRow,
  entitlementTablesExist,
  readBusyRooms,
  readEntitlement,
} from "./account-entitlements";
import {
  isPlanDurationDays,
  isValidPlanRooms,
  MAX_PLAN_ROOMS,
  MIN_PLAN_ROOMS,
  planEndsAt,
  planStateOf,
  renewalStartsAt,
  formatPlanDate,
  type Entitlement,
  type PlanDurationDays,
  type PlanState,
} from "./account-plan";

/**
 * Admin → Account Activation (app/admin/account-activation, app/api/admin/account-activation/*). Performs NO
 * authorization of its own: every caller resolves the admin from the session cookie first (getAdminSessionUser), and
 * the email in a request body is only ever a TARGET SELECTOR, matched exactly — never a source of authority.
 *
 * Every change is one write transaction that (1) answers a repeated operation id from its own audit row instead of
 * applying it again, (2) re-reads the target account and its plan, (3) refuses unless the plan is still the version the
 * admin reviewed, and (4) writes the plan and its audit row together — so a double click, a retried request or two open
 * tabs can never extend a plan twice or apply a change the admin did not see.
 *
 * Policies (explicit, shown in the console and tested):
 *  - activate     only for an account with no plan or an expired one. Starts now; ends exactly N days later.
 *  - renew        only for a current (active or suspended) plan. Adds N days to the current end date, so no paid day
 *                 is lost; the room count stays unless the admin enters a new one. A suspended plan stays suspended.
 *  - adjust_rooms any plan; a reason is required. Rooms are slots, not credits, so nothing "consumed" is affected: a
 *                 report in a room above the new count stays stored and reachable.
 *  - suspend      an active plan; a reason is required. New checks stop; reports stay readable; the end date does not
 *                 move (suspended days are not refunded).
 *  - reactivate   a suspended plan; the original end date applies.
 */

export const ACTIVATION_ACTIONS = ["activate", "renew", "adjust_rooms", "suspend", "reactivate"] as const;
export type ActivationAction = (typeof ACTIVATION_ACTIONS)[number];

export function isActivationAction(value: unknown): value is ActivationAction {
  return typeof value === "string" && (ACTIVATION_ACTIONS as readonly string[]).includes(value);
}

export const MAX_EMAIL_LENGTH = 254;
// Same shape check signup/login apply before persisting users.email.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** THE existing canonical account-email rule (signup, login, PATCH /api/auth/me): trim + lowercase. */
export function canonicalizeAccountEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
export function isValidAccountEmail(canonical: string): boolean {
  return canonical.length > 0 && canonical.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(canonical);
}

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidOperationId(value: unknown): value is string {
  return typeof value === "string" && OPERATION_ID_PATTERN.test(value);
}

export const MAX_REASON_LENGTH = 500;
const MIN_REQUIRED_REASON_LENGTH = 3;

export function actionRequiresReason(action: ActivationAction): boolean {
  return action === "adjust_rooms" || action === "suspend";
}

type Executor = Pick<Client, "execute"> | Pick<Transaction, "execute">;

type AccountRow = { id: string; email: string; username: string; role: string; created_at: string; email_verified_at?: number | bigint | null };

async function findAccountByEmail(client: Executor, canonicalEmail: string): Promise<{ kind: "found"; row: AccountRow } | { kind: "none" } | { kind: "conflict" }> {
  const verifiedColumn = await usersHaveEmailVerifiedAtColumn(client as Pick<Client, "execute">);
  const result = await client.execute({
    sql: `SELECT id, email, username, role, created_at${verifiedColumn ? ", email_verified_at" : ""} FROM users WHERE email = ?`,
    args: [canonicalEmail],
  });
  if (result.rows.length === 0) return { kind: "none" };
  if (result.rows.length > 1) return { kind: "conflict" };
  return { kind: "found", row: result.rows[0] as unknown as AccountRow };
}

/** "YYYY-MM-DD HH:MM:SS" (SQLite CURRENT_TIMESTAMP, UTC) or ISO -> epoch ms, or null. */
function sqliteTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type AccountSummary = {
  email: string;
  username: string;
  registeredAt: number | null;
  /** null when this database predates email verification (drizzle/0046). */
  emailVerified: boolean | null;
  isAdmin: boolean;
};

function accountSummary(row: AccountRow): AccountSummary {
  return {
    email: row.email,
    username: row.username,
    registeredAt: sqliteTimestampMs(row.created_at),
    emailVerified: row.email_verified_at === undefined ? null : row.email_verified_at !== null,
    isAdmin: row.role === "admin",
  };
}

export type ActivationEvent = {
  operationId: string;
  action: ActivationAction;
  adminEmail: string;
  previous: Entitlement | null;
  next: Entitlement;
  reason: string | null;
  /** Whether the customer's email was verified when the admin acted (false only after an explicit confirmation); null = unknown. */
  targetEmailVerified: boolean | null;
  createdAt: number;
};

/** An admin action's row (never an 'account_deleted' row, which has no admin and no new plan). */
type EventRow = {
  operation_id: string;
  user_id: string;
  action: string;
  admin_user_id: string;
  admin_email: string;
  previous_json: string | null;
  new_json: string;
  reason: string | null;
  target_email_verified: number | bigint | null;
  created_at: number | bigint;
};
const EVENT_COLUMNS = "operation_id, user_id, action, admin_user_id, admin_email, previous_json, new_json, reason, target_email_verified, created_at";

function eventFromRow(row: EventRow): ActivationEvent {
  return {
    operationId: row.operation_id,
    action: row.action as ActivationAction,
    adminEmail: row.admin_email,
    previous: row.previous_json ? (JSON.parse(row.previous_json) as Entitlement) : null,
    next: JSON.parse(row.new_json) as Entitlement,
    reason: row.reason,
    targetEmailVerified: row.target_email_verified === null ? null : Number(row.target_email_verified) === 1,
    createdAt: Number(row.created_at),
  };
}

/** Actions that give the customer access to new checks — the ones that need an explicit confirmation for an unverified email. */
export function actionGrantsAccess(action: ActivationAction): boolean {
  return action === "activate" || action === "renew" || action === "reactivate";
}

export type CustomerLookup =
  | { found: false; email: string }
  | {
      found: true;
      account: AccountSummary;
      entitlement: Entitlement | null;
      state: PlanState;
      /** Plan rooms holding a report or cooling down right now. */
      roomsBusy: number;
      history: ActivationEvent[];
      serverNow: number;
    };

export async function lookupCustomerAccount(client: Executor, rawEmail: string, nowMs: number = Date.now()): Promise<CustomerLookup | { conflict: true }> {
  const email = canonicalizeAccountEmail(rawEmail);
  const match = await findAccountByEmail(client, email);
  if (match.kind === "conflict") return { conflict: true };
  if (match.kind === "none") return { found: false, email };
  const userId = match.row.id;
  const entitlement = await readEntitlement(client, userId);
  let roomsBusy = 0;
  if (entitlement) {
    for (const room of (await readBusyRooms(client, userId, nowMs, true)).keys()) if (room < entitlement.rooms) roomsBusy += 1;
  }
  const history = await client.execute({
    sql: `SELECT ${EVENT_COLUMNS}
          FROM account_entitlement_events WHERE user_id = ? AND action != 'account_deleted' ORDER BY created_at DESC LIMIT 10`,
    args: [userId],
  });
  return {
    found: true,
    account: accountSummary(match.row),
    entitlement,
    state: planStateOf(entitlement, nowMs),
    roomsBusy,
    history: (history.rows as unknown as EventRow[]).map(eventFromRow),
    serverNow: nowMs,
  };
}

export type ActivationInput = {
  action: ActivationAction;
  planDays?: unknown;
  rooms?: unknown;
  reason?: unknown;
};

export type PlannedChange =
  | {
      ok: true;
      action: ActivationAction;
      previous: Entitlement | null;
      next: Entitlement;
      /** For a renewal: when the added days begin (the current end date). */
      extensionStartsAt: number | null;
      reason: string | null;
    }
  | { ok: false; status: 400 | 409; error: string };

/** The pure decision: what `input` would make of `current` at `nowMs`. Used for the preview AND, re-run on a fresh read, inside the apply transaction. */
export function planActivationChange(current: Entitlement | null, input: ActivationInput, nowMs: number): PlannedChange {
  const state = planStateOf(current, nowMs);
  const reasonRaw = typeof input.reason === "string" ? input.reason.trim() : "";
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== "string") {
    return { ok: false, status: 400, error: "reason must be text." };
  }
  if (reasonRaw.length > MAX_REASON_LENGTH) return { ok: false, status: 400, error: `Reason must be at most ${MAX_REASON_LENGTH} characters.` };
  if (actionRequiresReason(input.action) && reasonRaw.length < MIN_REQUIRED_REASON_LENGTH) {
    return { ok: false, status: 400, error: "Please write a short reason for this change." };
  }
  const reason = reasonRaw.length > 0 ? reasonRaw : null;
  const version = (current?.version ?? 0) + 1;
  const roomsError = `Number of Rooms must be a whole number from ${MIN_PLAN_ROOMS} to ${MAX_PLAN_ROOMS}.`;
  const durationError = "Plan Duration must be 30, 90, 180 or 360 days.";

  switch (input.action) {
    case "activate": {
      if (!isPlanDurationDays(input.planDays)) return { ok: false, status: 400, error: durationError };
      if (!isValidPlanRooms(input.rooms)) return { ok: false, status: 400, error: roomsError };
      if (current && (state === "active" || state === "suspended")) {
        return { ok: false, status: 409, error: `This account already has a plan until ${formatPlanDate(current.expiresAt)}. Use Renew / Extend instead.` };
      }
      const planDays: PlanDurationDays = input.planDays;
      return {
        ok: true,
        action: "activate",
        previous: current,
        next: {
          status: "active",
          planDays,
          rooms: input.rooms,
          activatedAt: nowMs,
          expiresAt: planEndsAt(nowMs, planDays),
          suspendedAt: null,
          version,
          createdAt: current?.createdAt ?? nowMs,
          updatedAt: nowMs,
        },
        extensionStartsAt: null,
        reason,
      };
    }
    case "renew": {
      if (!isPlanDurationDays(input.planDays)) return { ok: false, status: 400, error: durationError };
      if (input.rooms !== undefined && input.rooms !== null && !isValidPlanRooms(input.rooms)) return { ok: false, status: 400, error: roomsError };
      if (!current || state === "none" || state === "expired") {
        return { ok: false, status: 409, error: "This account has no current plan to renew. Use Activate Account instead." };
      }
      const planDays: PlanDurationDays = input.planDays;
      const startsAt = renewalStartsAt(current.expiresAt, nowMs);
      return {
        ok: true,
        action: "renew",
        previous: current,
        next: {
          ...current,
          planDays,
          rooms: isValidPlanRooms(input.rooms) ? input.rooms : current.rooms,
          expiresAt: planEndsAt(startsAt, planDays),
          version,
          updatedAt: nowMs,
        },
        extensionStartsAt: startsAt,
        reason,
      };
    }
    case "adjust_rooms": {
      if (!isValidPlanRooms(input.rooms)) return { ok: false, status: 400, error: roomsError };
      if (!current) return { ok: false, status: 409, error: "This account has no plan. Use Activate Account instead." };
      if (input.rooms === current.rooms) return { ok: false, status: 409, error: `The plan already has ${current.rooms} rooms.` };
      return { ok: true, action: "adjust_rooms", previous: current, next: { ...current, rooms: input.rooms, version, updatedAt: nowMs }, extensionStartsAt: null, reason };
    }
    case "suspend": {
      if (!current || state !== "active") return { ok: false, status: 409, error: "Only an active plan can be suspended." };
      return { ok: true, action: "suspend", previous: current, next: { ...current, status: "suspended", suspendedAt: nowMs, version, updatedAt: nowMs }, extensionStartsAt: null, reason };
    }
    case "reactivate": {
      if (!current || state !== "suspended") {
        return { ok: false, status: 409, error: state === "expired" ? "This plan has expired. Use Activate Account instead." : "This plan is not suspended." };
      }
      return { ok: true, action: "reactivate", previous: current, next: { ...current, status: "active", suspendedAt: null, version, updatedAt: nowMs }, extensionStartsAt: null, reason };
    }
  }
}

export type ApplyRequest = ActivationInput & {
  email: string;
  operationId: string;
  /** The plan version the admin reviewed (0 = no plan). */
  expectedVersion: number;
  /** Required (true) to grant access to an account whose email is not verified — the admin confirmed it explicitly. */
  confirmUnverifiedEmail?: boolean;
};

export type ApplyResult =
  | { outcome: "applied" | "replayed"; account: AccountSummary; event: ActivationEvent; state: PlanState }
  | {
      outcome: "rejected";
      status: 400 | 404 | 409;
      error: string;
      code?: "STALE" | "OPERATION_REUSED" | "NOT_FOUND" | "ADMIN_ACCOUNT" | "UNVERIFIED_EMAIL_CONFIRMATION_REQUIRED";
    };

const MAX_BUSY_RETRIES = 10;
function isSqliteBusyError(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY/i.test(err.message);
}

/** Fresh connection per SQLITE_BUSY retry — the same mechanism as lib/corpus-admission-admin-actions.ts. */
async function runWriteTransaction<T>(openConnection: () => Client | Promise<Client>, work: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_BUSY_RETRIES; attempt += 1) {
    const attemptClient = await openConnection();
    try {
      const tx = await attemptClient.transaction("write");
      try {
        const result = await work(tx);
        await tx.commit();
        return result;
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      } finally {
        tx.close();
      }
    } catch (err) {
      if (isSqliteBusyError(err) && attempt < MAX_BUSY_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
        continue;
      }
      throw err;
    } finally {
      attemptClient.close();
    }
  }
  throw new Error("account activation: exhausted retries without resolving");
}

/** A typed refusal that rolls the transaction back (thrown inside work, caught outside). */
class Refusal extends Error {
  constructor(readonly result: Extract<ApplyResult, { outcome: "rejected" }>) {
    super(result.error);
  }
}

export async function applyActivationAction(
  openConnection: () => Client | Promise<Client>,
  admin: SessionUser,
  request: ApplyRequest,
  nowMs: number = Date.now(),
): Promise<ApplyResult> {
  const email = canonicalizeAccountEmail(request.email);
  try {
    return await runWriteTransaction(openConnection, async (tx) => {
      // (1) Idempotency: the same confirmation, sent again, is answered from what it already did.
      const prior = await tx.execute({
        sql: `SELECT ${EVENT_COLUMNS} FROM account_entitlement_events WHERE operation_id = ?`,
        args: [request.operationId],
      });
      const priorRow = prior.rows[0] as unknown as EventRow | undefined;

      // (2) The target, re-read inside the transaction by its exact canonical email.
      const match = await findAccountByEmail(tx, email);
      if (match.kind === "conflict") throw new Refusal({ outcome: "rejected", status: 409, error: "More than one account has this email — refusing to guess." });
      if (match.kind === "none") {
        throw new Refusal({ outcome: "rejected", status: 404, code: "NOT_FOUND", error: "No account found for this email. Ask the customer to register first." });
      }
      const target = match.row;

      if (priorRow) {
        if (priorRow.user_id !== target.id || priorRow.action !== request.action || priorRow.admin_user_id !== admin.id) {
          throw new Refusal({ outcome: "rejected", status: 409, code: "OPERATION_REUSED", error: "This confirmation was already used for a different change. Review the account again." });
        }
        return { outcome: "replayed", account: accountSummary(target), event: eventFromRow(priorRow), state: planStateOf(JSON.parse(priorRow.new_json) as Entitlement, nowMs) };
      }

      if (target.role === "admin") {
        throw new Refusal({ outcome: "rejected", status: 409, code: "ADMIN_ACCOUNT", error: "Administrator accounts are never restricted and do not need activation." });
      }

      // An unverified email is never treated as verified: granting access to one needs the admin's explicit
      // confirmation in THIS request (the console's checkbox), and the audit row records that it was unverified.
      const emailVerified = accountSummary(target).emailVerified;
      if (actionGrantsAccess(request.action) && emailVerified === false && request.confirmUnverifiedEmail !== true) {
        throw new Refusal({
          outcome: "rejected",
          status: 409,
          code: "UNVERIFIED_EMAIL_CONFIRMATION_REQUIRED",
          error: "This customer's email address is not verified. Confirm that you checked the customer's identity yourself before granting access.",
        });
      }

      // (3) Optimistic concurrency: only the version the admin reviewed may be changed.
      const current = await readEntitlement(tx, target.id);
      if ((current?.version ?? 0) !== request.expectedVersion) {
        throw new Refusal({ outcome: "rejected", status: 409, code: "STALE", error: "This account's plan changed since you reviewed it. Review it again before confirming." });
      }

      const planned = planActivationChange(current, request, nowMs);
      if (!planned.ok) throw new Refusal({ outcome: "rejected", status: planned.status, error: planned.error });
      const next = planned.next;

      // (4) The plan and its audit row, together.
      await tx.execute({
        sql: `INSERT INTO account_entitlements (user_id, ${ENTITLEMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, plan_days = excluded.plan_days, rooms = excluded.rooms,
                activated_at = excluded.activated_at, expires_at = excluded.expires_at, suspended_at = excluded.suspended_at,
                version = excluded.version, updated_at = excluded.updated_at
              WHERE account_entitlements.version = ?`,
        args: [target.id, next.status, next.planDays, next.rooms, next.activatedAt, next.expiresAt, next.suspendedAt, next.version, next.createdAt, next.updatedAt, current?.version ?? 0],
      });
      const written = await readEntitlement(tx, target.id);
      if (!written || written.version !== next.version) {
        throw new Refusal({ outcome: "rejected", status: 409, code: "STALE", error: "This account's plan changed since you reviewed it. Review it again before confirming." });
      }
      const eventRow: EventRow = {
        operation_id: request.operationId,
        user_id: target.id,
        action: planned.action,
        admin_user_id: admin.id,
        admin_email: admin.email,
        previous_json: current ? JSON.stringify(current) : null,
        new_json: JSON.stringify(written),
        reason: planned.reason,
        target_email_verified: emailVerified === null ? null : emailVerified ? 1 : 0,
        created_at: nowMs,
      };
      await tx.execute({
        sql: `INSERT INTO account_entitlement_events (operation_id, user_id, target_email, admin_user_id, admin_email, action, previous_json, new_json, reason, target_email_verified, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [eventRow.operation_id, target.id, target.email, admin.id, admin.email, eventRow.action, eventRow.previous_json, eventRow.new_json, eventRow.reason, eventRow.target_email_verified, nowMs],
      });
      return { outcome: "applied", account: accountSummary(target), event: eventFromRow(eventRow), state: planStateOf(written, nowMs) };
    });
  } catch (err) {
    if (err instanceof Refusal) return err.result;
    // Two requests with the same operation id racing past step (1): the loser's audit insert hits the primary key.
    if (err instanceof Error && /SQLITE_CONSTRAINT/i.test(err.message) && /account_entitlement_events/i.test(err.message)) {
      return applyActivationAction(openConnection, admin, request, nowMs);
    }
    throw err;
  }
}

/** Reports in rooms at or above `rooms` that are still inside their 24 h cycle — shown when a room reduction is reviewed. */
export async function countBusyRoomsAtOrAbove(client: Executor, userId: string, rooms: number, nowMs: number): Promise<number> {
  let count = 0;
  for (const room of (await readBusyRooms(client, userId, nowMs, true)).keys()) if (room >= rooms) count += 1;
  return count;
}

export async function resolveAccountId(client: Executor, rawEmail: string): Promise<string | null> {
  const match = await findAccountByEmail(client, canonicalizeAccountEmail(rawEmail));
  return match.kind === "found" ? match.row.id : null;
}

export const ACCOUNT_LIST_PAGE_SIZE = 20;
export type AccountListFilter = "all" | "active" | "expired" | "suspended";

export type AccountListRow = {
  email: string;
  username: string;
  emailVerified: boolean | null;
  planDays: number;
  activatedAt: number;
  expiresAt: number;
  rooms: number;
  roomsAvailable: number;
  state: PlanState;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Accounts that have (or had) a plan, newest change first. `query` is an email substring (admin search only). */
export async function listActivatedAccounts(
  client: Executor,
  options: { query?: string; filter?: AccountListFilter; page?: number },
  nowMs: number = Date.now(),
): Promise<{ rows: AccountListRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const where: string[] = [];
  const args: (string | number)[] = [];
  const query = canonicalizeAccountEmail(options.query ?? "");
  if (query.length > 0) {
    where.push("u.email LIKE ? ESCAPE '\\'");
    args.push(`%${escapeLike(query)}%`);
  }
  const filter = options.filter ?? "all";
  if (filter === "active") { where.push("e.status = 'active' AND e.expires_at > ?"); args.push(nowMs); }
  if (filter === "suspended") { where.push("e.status = 'suspended' AND e.expires_at > ?"); args.push(nowMs); }
  if (filter === "expired") { where.push("e.expires_at <= ?"); args.push(nowMs); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const totalResult = await client.execute({ sql: `SELECT COUNT(*) AS n FROM account_entitlements e JOIN users u ON u.id = e.user_id ${whereSql}`, args });
  const total = Number((totalResult.rows[0] as unknown as { n: number | bigint }).n);

  const verifiedColumn = await usersHaveEmailVerifiedAtColumn(client as Pick<Client, "execute">);
  const result = await client.execute({
    sql: `SELECT u.id AS user_id, u.email AS email, u.username AS username${verifiedColumn ? ", u.email_verified_at AS email_verified_at" : ""},
                 ${ENTITLEMENT_COLUMNS.split(", ").map((c) => `e.${c} AS ${c}`).join(", ")}
          FROM account_entitlements e JOIN users u ON u.id = e.user_id ${whereSql}
          ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`,
    args: [...args, ACCOUNT_LIST_PAGE_SIZE, (page - 1) * ACCOUNT_LIST_PAGE_SIZE],
  });

  const rows: AccountListRow[] = [];
  for (const raw of result.rows as unknown as Array<Record<string, unknown>>) {
    const entitlement = entitlementFromRow(raw as unknown as Parameters<typeof entitlementFromRow>[0]);
    const state = planStateOf(entitlement, nowMs);
    let busy = 0;
    for (const room of (await readBusyRooms(client, String(raw.user_id), nowMs, true)).keys()) if (room < entitlement.rooms) busy += 1;
    rows.push({
      email: String(raw.email),
      username: String(raw.username),
      emailVerified: verifiedColumn ? raw.email_verified_at !== null : null,
      planDays: entitlement.planDays,
      activatedAt: entitlement.activatedAt,
      expiresAt: entitlement.expiresAt,
      rooms: entitlement.rooms,
      roomsAvailable: state === "active" ? entitlement.rooms - busy : 0,
      state,
    });
  }
  return { rows, total, page, pageSize: ACCOUNT_LIST_PAGE_SIZE };
}

export { entitlementTablesExist };
