import type { Client, Transaction } from "@libsql/client";
import type { SessionUser } from "./auth-session";
import { getRoomCountForRole, isWithinActiveCycle, ROOM_CYCLE_MS } from "./report-rooms";
import { roomTimeSql } from "./report-history";
import {
  DAY_MS,
  isPlanDurationDays,
  LEGACY_GRACE_DAYS,
  legacyGraceMessage,
  planBlockMessage,
  planStateOf,
  type Entitlement,
  type PlanBlockCode,
  type PlanState,
} from "./account-plan";

/**
 * Manual account activation — the server-side policy (drizzle/0057). The ONLY place that decides, for one signed-in
 * account, how many rooms it has, whether the daily upload cap applies, and whether it may start a new check.
 * app/api/reports/route.ts (POST + room GET), app/api/reports/rooms/route.ts, app/reports/rooms/[room]/page.tsx,
 * app/api/upload-limit/route.ts and app/api/account/plan/route.ts all ask resolveRoomPolicy; none of them decides on
 * its own.
 *
 * ACCOUNT_ACTIVATION_ENFORCED switch:
 *  - OFF (the default): every answer is exactly the pre-feature one — getRoomCountForRole's 10/40 rooms, the daily cap
 *    for non-admin accounts, nothing blocked — and no entitlement table is read at all, so an environment without
 *    drizzle/0057 behaves exactly as before.
 *  - ON: administrator accounts are unaffected (their 40 rooms, no cap). A customer account may start a new check only
 *    with an active plan (not expired, not suspended), only in rooms 1..plan.rooms, and without the daily cap. Every
 *    room keeps its own 24 h cooldown, measured from the SERVER's clock (account_room_claims) as well as from the
 *    report's own createdAt, so deleting a report or back-dating createdAt can never free a room early. A save of an
 *    already-existing report (the AI result, a background retry, a resave) is never a new check, so an active plan never
 *    blocks it. Without an active subscription nothing is saved or readable (REPORT ACCESS below).
 *
 * NO FREE CHECKING (owner decision 2026-10-29): with the switch on, the ONLY way for a non-admin account to start a
 * new check is an active plan — new and existing accounts alike. The check-work routes (/api/academic-evidence,
 * /api/archive/match) refuse the same accounts through checkWorkRefusal, so nothing can be bypassed through the API.
 *
 * LEGACY FREE ACCESS — RETIRED, kept only behind ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED (off unless explicitly set):
 * the first enforced request records, once and for good, when enforcement began (account_activation_enforcement).
 * With the grace flag on, an account registered BEFORE that moment, with no active or suspended plan, would keep the
 * pre-feature policy (10 rooms, the daily cap) until LEGACY_GRACE_DAYS later. With it off (the intended behavior) the
 * start is still recorded but grants nothing.
 */

export function accountActivationEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ACCOUNT_ACTIVATION_ENFORCED;
  return raw === "1" || raw === "true";
}

/** The retired legacy free-access period — OFF unless ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED is explicitly on. */
export function legacyGraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ACCOUNT_ACTIVATION_LEGACY_GRACE_ENABLED;
  return raw === "1" || raw === "true";
}

type Executor = Pick<Client, "execute"> | Pick<Transaction, "execute">;

let tablesKnownPresent = false;

/** Whether drizzle/0057 has been applied. A positive answer is remembered for the process; a negative one is re-checked. */
export async function entitlementTablesExist(client: Executor): Promise<boolean> {
  if (tablesKnownPresent) return true;
  const result = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('account_entitlements', 'account_entitlement_events', 'account_room_claims', 'account_check_authorizations', 'account_activation_enforcement')",
    args: [],
  });
  const present = Number((result.rows[0] as unknown as { n: number | bigint }).n) === 5;
  if (present) tablesKnownPresent = true;
  return present;
}

/** Tests only: forget everything remembered for the process (a test may drop or recreate its database, or simulate a restart). */
export function resetEntitlementTableCacheForTest(): void {
  tablesKnownPresent = false;
  enforcementStartCache = null;
}

export type EnforcementStart = { startedAt: number; graceEndsAt: number };
let enforcementStartCache: EnforcementStart | null = null;

/** The recorded start of enforcement on this database, or null if it has never been switched on. Never writes. */
export async function readEnforcementStart(client: Executor): Promise<EnforcementStart | null> {
  if (enforcementStartCache) return enforcementStartCache;
  const result = await client.execute({ sql: "SELECT started_at, grace_ends_at FROM account_activation_enforcement WHERE id = 1", args: [] });
  const row = result.rows[0] as unknown as { started_at: number | bigint; grace_ends_at: number | bigint } | undefined;
  if (!row) return null;
  enforcementStartCache = { startedAt: Number(row.started_at), graceEndsAt: Number(row.grace_ends_at) };
  return enforcementStartCache;
}

/**
 * The start of enforcement, recording `nowMs` as that start if none exists yet. INSERT OR IGNORE plus the table's
 * single-row key make the first writer win even under concurrent first requests, and its triggers make the row
 * immutable, so the answer never changes for this database once given.
 */
export async function ensureEnforcementStart(client: Executor, nowMs: number): Promise<EnforcementStart> {
  const existing = await readEnforcementStart(client);
  if (existing) return existing;
  await client.execute({
    sql: "INSERT OR IGNORE INTO account_activation_enforcement (id, started_at, grace_ends_at) VALUES (1, ?, ?)",
    args: [nowMs, nowMs + LEGACY_GRACE_DAYS * DAY_MS],
  });
  const recorded = await readEnforcementStart(client);
  if (!recorded) throw new Error("account_activation_enforcement: start was not recorded");
  return recorded;
}

/** "YYYY-MM-DD HH:MM:SS" (SQLite CURRENT_TIMESTAMP, UTC) or ISO -> epoch ms, or null. */
export function sqliteTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether an account registered at `createdAt` (users.created_at) predates enforcement. users.created_at has one-second
 * precision, so an account created within the second enforcement began is treated as new (never as legacy); an
 * unreadable timestamp is treated as new too.
 */
export function registeredBeforeEnforcement(createdAt: string | null | undefined, start: EnforcementStart): boolean {
  const createdMs = sqliteTimestampMs(createdAt);
  return createdMs !== null && createdMs < Math.floor(start.startedAt / 1000) * 1000;
}

/**
 * When `userId`'s legacy free access ends, if the account is legacy (whether or not that moment has passed); else null.
 * Always null while the retired grace period is switched off (legacyGraceEnabled), so no caller can grant it.
 */
export async function legacyGraceEndsAt(client: Executor, userId: string, start: EnforcementStart | null): Promise<number | null> {
  if (!start || !legacyGraceEnabled()) return null;
  const result = await client.execute({ sql: "SELECT created_at FROM users WHERE id = ?", args: [userId] });
  const createdAt = (result.rows[0] as unknown as { created_at: string } | undefined)?.created_at;
  return registeredBeforeEnforcement(createdAt, start) ? start.graceEndsAt : null;
}

type EntitlementRow = {
  status: string;
  plan_days: number | bigint;
  rooms: number | bigint;
  activated_at: number | bigint;
  expires_at: number | bigint;
  suspended_at: number | bigint | null;
  version: number | bigint;
  created_at: number | bigint;
  updated_at: number | bigint;
};

export function entitlementFromRow(row: EntitlementRow): Entitlement {
  const planDays = Number(row.plan_days);
  if (!isPlanDurationDays(planDays)) throw new Error(`account_entitlements: unexpected plan_days ${planDays}`);
  return {
    status: row.status === "suspended" ? "suspended" : "active",
    planDays,
    rooms: Number(row.rooms),
    activatedAt: Number(row.activated_at),
    expiresAt: Number(row.expires_at),
    suspendedAt: row.suspended_at === null ? null : Number(row.suspended_at),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export const ENTITLEMENT_COLUMNS = "status, plan_days, rooms, activated_at, expires_at, suspended_at, version, created_at, updated_at";

export async function readEntitlement(client: Executor, userId: string): Promise<Entitlement | null> {
  const result = await client.execute({
    sql: `SELECT ${ENTITLEMENT_COLUMNS} FROM account_entitlements WHERE user_id = ?`,
    args: [userId],
  });
  const row = result.rows[0] as unknown as EntitlementRow | undefined;
  return row ? entitlementFromRow(row) : null;
}

export type RoomPolicy = {
  /** True when the switch is on AND this account is subject to it (never for an administrator). */
  enforced: boolean;
  /** Rooms the room list shows and the room pages accept — never fewer than the highest room already holding a report. */
  visibleRoomCount: number;
  /** Rooms 0..uploadRoomCount-1 accept a new check (0 when new checks are blocked). */
  uploadRoomCount: number;
  /** Whether lib/upload-limit.ts's 10-per-UTC-day cap applies to a new check. */
  dailyCapApplies: boolean;
  /** Why no new check may start right now, or null. */
  block: { code: PlanBlockCode; message: string } | null;
  /** Whether a new check must also pass the server-clock room cooldown (account_room_claims). */
  usesRoomClaims: boolean;
  entitlement: Entitlement | null;
  state: PlanState | null;
  /** Set while this account is in its legacy free-access period (it then gets exactly the pre-feature policy). */
  grace: { endsAt: number } | null;
};

function baselinePolicy(user: SessionUser): RoomPolicy {
  const count = getRoomCountForRole(user.role);
  return {
    enforced: false,
    visibleRoomCount: count,
    uploadRoomCount: count,
    dailyCapApplies: user.role !== "admin",
    block: null,
    usesRoomClaims: false,
    entitlement: null,
    state: null,
    grace: null,
  };
}

async function highestUsedRoomCount(client: Executor, userId: string): Promise<number> {
  const result = await client.execute({
    sql: "SELECT MAX(room_number) AS top FROM saved_reports WHERE user_id = ? AND room_number IS NOT NULL",
    args: [userId],
  });
  const top = (result.rows[0] as unknown as { top: number | bigint | null } | undefined)?.top;
  return top === null || top === undefined ? 0 : Number(top) + 1;
}

export async function resolveRoomPolicy(client: Executor, user: SessionUser, nowMs: number = Date.now()): Promise<RoomPolicy> {
  if (!accountActivationEnforced()) return baselinePolicy(user);

  const tablesPresent = await entitlementTablesExist(client);
  // Any enforced request (an administrator's too) fixes the start of enforcement on this database, once.
  const start = tablesPresent ? await ensureEnforcementStart(client, nowMs) : null;
  if (user.role === "admin") return baselinePolicy(user);

  const usedRooms = await highestUsedRoomCount(client, user.id);
  if (!tablesPresent) {
    // Switched on without drizzle/0057: fail closed for new checks, keep every existing report reachable.
    const code: PlanBlockCode = "ACTIVATION_UNAVAILABLE";
    return {
      enforced: true,
      visibleRoomCount: Math.max(usedRooms, 1),
      uploadRoomCount: 0,
      dailyCapApplies: false,
      block: { code, message: planBlockMessage(code, null) },
      usesRoomClaims: false,
      entitlement: null,
      state: null,
      grace: null,
    };
  }

  const entitlement = await readEntitlement(client, user.id);
  const state = planStateOf(entitlement, nowMs);
  if (state === "active" && entitlement) {
    return {
      enforced: true,
      visibleRoomCount: Math.max(entitlement.rooms, usedRooms),
      uploadRoomCount: entitlement.rooms,
      dailyCapApplies: false,
      block: null,
      usesRoomClaims: true,
      entitlement,
      state,
      grace: null,
    };
  }
  if (state !== "suspended") {
    const graceEndsAt = await legacyGraceEndsAt(client, user.id, start);
    if (graceEndsAt !== null && nowMs < graceEndsAt) {
      // Legacy free access: exactly the pre-feature policy (10 rooms, the daily cap, no room claims), with every
      // room that already holds a report (for instance under an expired plan) still listed.
      const baseline = baselinePolicy(user);
      return {
        ...baseline,
        visibleRoomCount: Math.max(baseline.visibleRoomCount, entitlement?.rooms ?? 0, usedRooms),
        entitlement,
        state,
        grace: { endsAt: graceEndsAt },
      };
    }
  }
  const code: PlanBlockCode = state === "none" ? "ACTIVATION_REQUIRED" : state === "expired" ? "PLAN_EXPIRED" : "ACCOUNT_SUSPENDED";
  return {
    enforced: true,
    // Every room that holds a report (or belonged to the plan) stays listed; an account with none still sees one
    // room, so the normal My Reports -> room flow shows the locked upload area instead of an empty list or a 404.
    visibleRoomCount: Math.max(entitlement?.rooms ?? 0, usedRooms, 1),
    uploadRoomCount: 0,
    dailyCapApplies: false,
    block: { code, message: planBlockMessage(code, entitlement) },
    usesRoomClaims: true,
    entitlement,
    state,
    grace: null,
  };
}

/**
 * Why a new check in `room` must be refused, given an already-resolved policy — or null when it may proceed (subject
 * to the room's own occupancy, which the insert transaction decides).
 */
export function newCheckRefusal(policy: RoomPolicy, room: number): { code: PlanBlockCode; message: string } | null {
  if (policy.block) return policy.block;
  if (policy.enforced && room >= policy.uploadRoomCount) {
    return { code: "ROOM_NOT_IN_PLAN", message: planBlockMessage("ROOM_NOT_IN_PLAN", policy.entitlement) };
  }
  return null;
}

/**
 * REPORT ACCESS (owner decision 2026-10-30). With enforcement on, an account without an active subscription — never
 * activated, expired or suspended — may neither start a check NOR open, print, re-save, retry or download a receipt for
 * any report it saved. Decided here, server-side, from the same policy as a new check, never by hiding links. An expired
 * plan's reports are also deleted (lib/subscription-expiry-cleanup.ts), but access is refused from the moment it expires
 * whether or not that cleanup has run. A suspended plan's reports are kept and readable again on reactivation (if the
 * plan is still valid). Administrators are never refused (their policy has no block). ACTIVATION_UNAVAILABLE (the
 * subscription tables are missing) refuses only new checks: existing reports stay reachable, as before.
 */
export const REPORT_ACCESS_BLOCK_CODES: ReadonlySet<PlanBlockCode> = new Set<PlanBlockCode>(["ACTIVATION_REQUIRED", "PLAN_EXPIRED", "ACCOUNT_SUSPENDED"]);

export function reportAccessRefusal(policy: RoomPolicy): { code: PlanBlockCode; message: string } | null {
  return policy.enforced && policy.block && REPORT_ACCESS_BLOCK_CODES.has(policy.block.code) ? policy.block : null;
}

/** reportAccessRefusal for a signed-in session (null for no session, an administrator, or enforcement off). */
export async function reportAccessRefusalFor(client: Executor, user: SessionUser | null, nowMs: number = Date.now()): Promise<{ code: PlanBlockCode; message: string } | null> {
  if (!user || !accountActivationEnforced()) return null;
  return reportAccessRefusal(await resolveRoomPolicy(client, user, nowMs));
}

/**
 * CHECK AUTHORIZATION — a check started while the plan was active may save after the plan expires.
 *
 * Owner decision 2026-10-30: this no longer lets a check finish after expiry — POST /api/reports refuses every save of an
 * account without an active subscription first (reportAccessRefusal). What remains is only the instant between that
 * refusal and the save's own write transaction, where the transaction's re-check would otherwise lose a racing save.
 *
 * The browser analyses a document for minutes before its first save; a plan can expire in between. So when the room
 * page starts a check it asks for a check authorization (issueCheckAuthorization, POST /api/reports/check-authorization)
 * for its room and the SHA-256 of the manuscript's canonical text (lib/canonical-text.ts). One is issued only while
 * the plan is active and the room is free; it is valid for CHECK_AUTHORIZATION_TTL_MS. If the plan has EXPIRED by the
 * time that check's first save arrives, the save is still accepted when — inside its own write transaction — the
 * authorization is unconsumed, unexpired, issued before the plan's expiry, and matches the same account, room and text;
 * it is consumed in that transaction. It therefore permits exactly one save of exactly the document it was issued for:
 * it can never start another check after expiry or be replayed for another document, and the room's own cooldown and
 * occupancy rules still apply. A suspended plan is never overridden (the owner paused it on purpose). Resaves of an
 * existing report (the AI result, background retries) never needed one: they are not new checks.
 */
export const CHECK_AUTHORIZATION_TTL_MS = 60 * 60 * 1000;
const CHECK_AUTHORIZATION_ID = /^[0-9a-f]{32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
export type CheckAuthorizationRef = { id: string; textSha256: string };

export function parseCheckAuthorizationId(value: unknown): string | null {
  return typeof value === "string" && CHECK_AUTHORIZATION_ID.test(value) ? value : null;
}
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

async function authorizationHonoured(exec: Executor, userId: string, room: number, ref: CheckAuthorizationRef, entitlement: Entitlement, nowMs: number): Promise<boolean> {
  const result = await exec.execute({
    sql: `SELECT 1 FROM account_check_authorizations
          WHERE id = ? AND user_id = ? AND room_number = ? AND text_sha256 = ? AND consumed_at IS NULL AND expires_at > ? AND issued_at < ?`,
    args: [ref.id, userId, room, ref.textSha256, nowMs, entitlement.expiresAt],
  });
  return result.rows.length === 1;
}

/**
 * The request-level view of a first save that carries a check authorization: when the only obstacle is an expired plan
 * and the authorization would be honoured, the save proceeds under the plan's rooms (the insert transaction decides for
 * good and consumes it). Any other policy is returned unchanged.
 */
export async function policyWithCheckAuthorization(
  client: Executor,
  userId: string,
  policy: RoomPolicy,
  room: number,
  ref: CheckAuthorizationRef | null,
  nowMs: number = Date.now(),
): Promise<RoomPolicy> {
  if (!ref || policy.block?.code !== "PLAN_EXPIRED" || !policy.entitlement) return policy;
  if (!(await authorizationHonoured(client, userId, room, ref, policy.entitlement, nowMs))) return policy;
  return { ...policy, block: null, uploadRoomCount: policy.entitlement.rooms, usesRoomClaims: true, dailyCapApplies: false };
}

export type CheckWorkRefusal = { status: 401 | 403; code: PlanBlockCode | "SIGN_IN_REQUIRED"; message: string };

/**
 * The gate for the routes that do a check's server-side work before its save (/api/academic-evidence,
 * /api/archive/match): with enforcement on, only a signed-in administrator or an account allowed to start a new
 * check may use them, so an unsubscribed account cannot get similarity results through the API without saving a
 * report either. Owner decision 2026-10-30: an expired plan stops checks immediately, including one already under way —
 * an open check authorization no longer lets its remaining work through (the save would be refused anyway).
 * Returns null when the request may proceed; with enforcement off, always null (today's behaviour).
 */
export async function checkWorkRefusal(
  client: Executor,
  user: SessionUser | null,
  _textSha256: string,
  nowMs: number = Date.now(),
): Promise<CheckWorkRefusal | null> {
  if (!accountActivationEnforced()) return null;
  if (!user) return { status: 401, code: "SIGN_IN_REQUIRED", message: "Log in to check a document." };
  const policy = await resolveRoomPolicy(client, user, nowMs);
  if (!policy.block) return null;
  return { status: 403, code: policy.block.code, message: policy.block.message };
}

export type CheckAuthorizationIssue =
  | { kind: "not_required" }
  | { kind: "blocked"; code: PlanBlockCode; message: string }
  | { kind: "busy"; availableAt: number }
  | { kind: "issued"; id: string; expiresAt: number };

/** Issues one check authorization for `room` and `textSha256` — only while the plan is active and the room is free. */
export async function issueCheckAuthorization(
  client: Executor,
  user: SessionUser,
  room: number,
  textSha256: string,
  newId: () => string,
  nowMs: number = Date.now(),
): Promise<CheckAuthorizationIssue> {
  const policy = await resolveRoomPolicy(client, user, nowMs);
  if (!policy.enforced) return { kind: "not_required" };
  const refusal = newCheckRefusal(policy, room);
  if (refusal) return { kind: "blocked", ...refusal };
  const busyUntil = (await readBusyRooms(client, user.id, nowMs, true)).get(room);
  if (busyUntil !== undefined) return { kind: "busy", availableAt: busyUntil };
  const id = newId();
  const expiresAt = nowMs + CHECK_AUTHORIZATION_TTL_MS;
  // One open authorization per room (a newer check in the same room replaces an unused older one); old rows go.
  await client.execute({
    sql: `DELETE FROM account_check_authorizations
          WHERE user_id = ? AND ((room_number = ? AND consumed_at IS NULL) OR expires_at < ?)`,
    args: [user.id, room, nowMs - 30 * 24 * 60 * 60 * 1000],
  });
  await client.execute({
    sql: "INSERT INTO account_check_authorizations (id, user_id, room_number, text_sha256, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, user.id, room, textSha256, nowMs, expiresAt],
  });
  return { kind: "issued", id, expiresAt };
}

/** Marks the authorization used by the save that just inserted `reportId` — in that save's transaction. */
export async function consumeCheckAuthorization(tx: Executor, ref: CheckAuthorizationRef, reportId: string, nowMs: number): Promise<void> {
  const result = await tx.execute({
    sql: "UPDATE account_check_authorizations SET consumed_at = ?, report_id = ? WHERE id = ? AND consumed_at IS NULL",
    args: [nowMs, reportId, ref.id],
  });
  if (Number(result.rowsAffected) !== 1) throw new Error("check authorization was consumed concurrently");
}

export type PlanClaimDecision =
  | { kind: "ok"; consumeAuthorization: boolean }
  | { kind: "blocked"; code: PlanBlockCode; message: string }
  | { kind: "cooldown"; claimedAt: number };

/**
 * The authoritative re-check, INSIDE the write transaction that inserts a new check (app/api/reports/route.ts
 * insertReportWithRoomCheck), so a suspension, an expiry or another upload that lands between the request's first
 * policy read and its insert is seen. SQLite serializes write transactions, so two concurrent uploads into one room
 * cannot both pass: the second sees the first one's claim. A check authorization (see above) is honoured here only for
 * an expired plan, and is reported back for consumption whenever it is valid.
 */
export async function checkPlanClaimInTransaction(
  tx: Executor,
  userId: string,
  room: number,
  nowMs: number,
  authorization: CheckAuthorizationRef | null = null,
): Promise<PlanClaimDecision> {
  const entitlement = await readEntitlement(tx, userId);
  const state = planStateOf(entitlement, nowMs);
  const authorized = Boolean(
    authorization && entitlement && (state === "active" || state === "expired") && (await authorizationHonoured(tx, userId, room, authorization, entitlement, nowMs)),
  );
  if (!entitlement || (state !== "active" && !(state === "expired" && authorized))) {
    const code: PlanBlockCode = state === "none" ? "ACTIVATION_REQUIRED" : state === "expired" ? "PLAN_EXPIRED" : "ACCOUNT_SUSPENDED";
    return { kind: "blocked", code, message: planBlockMessage(code, entitlement) };
  }
  if (room >= entitlement.rooms) {
    return { kind: "blocked", code: "ROOM_NOT_IN_PLAN", message: planBlockMessage("ROOM_NOT_IN_PLAN", entitlement) };
  }
  const claim = await tx.execute({
    sql: "SELECT claimed_at FROM account_room_claims WHERE user_id = ? AND room_number = ?",
    args: [userId, room],
  });
  const claimedAt = (claim.rows[0] as unknown as { claimed_at: number | bigint } | undefined)?.claimed_at;
  if (claimedAt !== undefined && nowMs - Number(claimedAt) < ROOM_CYCLE_MS) return { kind: "cooldown", claimedAt: Number(claimedAt) };
  return { kind: "ok", consumeAuthorization: authorized };
}

/** Records the claim a new check just made, in the same transaction as its insert. */
export async function recordRoomClaim(tx: Executor, userId: string, room: number, nowMs: number): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO account_room_claims (user_id, room_number, claimed_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id, room_number) DO UPDATE SET claimed_at = excluded.claimed_at`,
    args: [userId, room, nowMs],
  });
}

/** room -> server-clock claim time, for rooms claimed within the last 24 h. */
export async function readActiveRoomClaims(client: Executor, userId: string, nowMs: number): Promise<Map<number, number>> {
  const result = await client.execute({
    sql: "SELECT room_number, claimed_at FROM account_room_claims WHERE user_id = ? AND claimed_at > ?",
    args: [userId, nowMs - ROOM_CYCLE_MS],
  });
  const claims = new Map<number, number>();
  for (const row of result.rows as unknown as { room_number: number | bigint; claimed_at: number | bigint }[]) {
    claims.set(Number(row.room_number), Number(row.claimed_at));
  }
  return claims;
}

/**
 * room -> the moment it becomes free again, for every room busy right now: the later of its current report's 24 h
 * cycle (room time — the server's saved_at with report history retention on, lib/report-history.ts) and its
 * server-clock claim.
 */
export async function readBusyRooms(client: Executor, userId: string, nowMs: number, withClaims: boolean): Promise<Map<number, number>> {
  const result = await client.execute({
    sql: `SELECT room_number, MAX(${roomTimeSql()}) AS most_recent FROM saved_reports
          WHERE user_id = ? AND room_number IS NOT NULL GROUP BY room_number`,
    args: [userId],
  });
  const busy = new Map<number, number>();
  for (const row of result.rows as unknown as { room_number: number | bigint; most_recent: string }[]) {
    if (isWithinActiveCycle(row.most_recent, nowMs)) busy.set(Number(row.room_number), Date.parse(row.most_recent) + ROOM_CYCLE_MS);
  }
  if (withClaims) {
    for (const [room, claimedAt] of await readActiveRoomClaims(client, userId, nowMs)) {
      busy.set(room, Math.max(busy.get(room) ?? 0, claimedAt + ROOM_CYCLE_MS));
    }
  }
  return busy;
}

/** What the customer's own account page shows (GET /api/account/plan). Never role-shaped beyond `exempt`. */
export type CustomerPlanView =
  | { enforced: false }
  | { enforced: true; exempt: true }
  | {
      enforced: true;
      exempt: false;
      state: PlanState | "unavailable";
      planDays: number | null;
      activatedAt: number | null;
      expiresAt: number | null;
      rooms: { allocated: number; available: number; cooling: number } | null;
      /** While set, the account is in its legacy free-access period (pre-feature limits) until this moment. */
      graceEndsAt: number | null;
      message: string | null;
    };

export async function buildCustomerPlanView(client: Executor, user: SessionUser, nowMs: number = Date.now()): Promise<CustomerPlanView> {
  if (!accountActivationEnforced()) return { enforced: false };
  if (user.role === "admin") return { enforced: true, exempt: true };
  const policy = await resolveRoomPolicy(client, user, nowMs);
  if (policy.block?.code === "ACTIVATION_UNAVAILABLE") {
    return { enforced: true, exempt: false, state: "unavailable", planDays: null, activatedAt: null, expiresAt: null, rooms: null, graceEndsAt: null, message: policy.block.message };
  }
  const entitlement = policy.entitlement;
  let rooms: { allocated: number; available: number; cooling: number } | null = null;
  if (entitlement) {
    const busy = await readBusyRooms(client, user.id, nowMs, true);
    let cooling = 0;
    for (const room of busy.keys()) if (room < entitlement.rooms) cooling += 1;
    rooms = {
      allocated: entitlement.rooms,
      available: policy.state === "active" ? entitlement.rooms - cooling : 0,
      cooling,
    };
  }
  return {
    enforced: true,
    exempt: false,
    state: policy.state ?? "none",
    planDays: entitlement?.planDays ?? null,
    activatedAt: entitlement?.activatedAt ?? null,
    expiresAt: entitlement?.expiresAt ?? null,
    rooms,
    graceEndsAt: policy.grace?.endsAt ?? null,
    message: policy.grace ? legacyGraceMessage(policy.grace.endsAt) : policy.block?.message ?? null,
  };
}
