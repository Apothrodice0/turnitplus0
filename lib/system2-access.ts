import type { Client } from "@libsql/client";
import type { SessionUser } from "./auth-session";
import { accountActivationEnforced, resolveRoomPolicy, type RoomPolicy } from "./account-entitlements";
import { usersHaveEmailVerifiedAtColumn } from "./email-verification";
import { isSystem2ResearchUser, system2Config, type System2Config } from "./system2-research";

/**
 * ENGLISH SYSTEM 2 — WHO may run it, decided on the server for every request (the room page, to arm the one automatic
 * request after the save, and app/api/reports/[id]/system2 itself, which refuses everyone else with a plain 404).
 *
 * In this order:
 *  1. the feature is configured for this deployment (lib/system2-research.ts; production needs its own extra switch);
 *  2. a signed-in account;
 *  3. an administrator, or an account on the owner allowlist — always (their rooms are never plan-bound);
 *  4. otherwise, only with S2_SUBSCRIBERS_ENABLED and subscription enforcement on: a customer whose subscription is
 *     ACTIVE right now (lib/account-entitlements.ts resolveRoomPolicy — never the legacy free-access grace, never
 *     expired, suspended, or without one), whose email is verified (read fresh, never from the session), and — when a
 *     room is given — only for a room inside the purchased plan.
 *
 * Display is NOT gated here: a report's stored estimate is part of that report (lib/system2-estimate-record.ts), so it
 * stays the same on every view even after the subscription ends. This only decides who may START a new estimate.
 */

export type System2AccessReason =
  | "ADMIN"
  | "OWNER"
  | "SUBSCRIBER"
  | "OFF"
  | "SIGNED_OUT"
  | "SUBSCRIBERS_OFF"
  | "SUBSCRIPTIONS_OFF"
  | "NO_SUBSCRIPTION"
  | "EXPIRED"
  | "SUSPENDED"
  | "UNAVAILABLE"
  | "UNVERIFIED"
  | "ROOM_NOT_IN_PLAN";

export type System2Access = { allowed: boolean; reason: System2AccessReason };

const allow = (reason: System2AccessReason): System2Access => ({ allowed: true, reason });
const deny = (reason: System2AccessReason): System2Access => ({ allowed: false, reason });

async function emailVerified(client: Pick<Client, "execute">, userId: string): Promise<boolean> {
  if (!(await usersHaveEmailVerifiedAtColumn(client))) return false;
  const row = (await client.execute({ sql: "SELECT email_verified_at FROM users WHERE id = ?", args: [userId] })).rows[0] as unknown as
    | { email_verified_at: number | bigint | null }
    | undefined;
  return row !== undefined && row.email_verified_at !== null;
}

export async function resolveSystem2Access(
  client: Client,
  user: SessionUser | null | undefined,
  options: { room?: number | null; policy?: RoomPolicy; config?: System2Config; nowMs?: number } = {},
): Promise<System2Access> {
  const config = options.config ?? system2Config();
  if (!config.enabled) return deny("OFF");
  if (!user) return deny("SIGNED_OUT");
  if (user.role === "admin") return allow("ADMIN");
  if (isSystem2ResearchUser(user, config)) return allow("OWNER");
  if (!config.subscribersEnabled) return deny("SUBSCRIBERS_OFF");
  if (!accountActivationEnforced()) return deny("SUBSCRIPTIONS_OFF");

  const policy = options.policy ?? (await resolveRoomPolicy(client, user, options.nowMs));
  if (!policy.enforced) return deny("SUBSCRIPTIONS_OFF");
  if (policy.state !== "active" || !policy.entitlement || policy.block !== null || policy.grace !== null) {
    if (policy.state === "expired") return deny("EXPIRED");
    if (policy.state === "suspended") return deny("SUSPENDED");
    if (policy.state === "none") return deny("NO_SUBSCRIPTION");
    return deny("UNAVAILABLE");
  }
  if (!(await emailVerified(client, user.id))) return deny("UNVERIFIED");
  if (options.room !== undefined) {
    const room = options.room;
    if (room === null || !Number.isInteger(room) || room < 0 || room >= policy.entitlement.rooms) return deny("ROOM_NOT_IN_PLAN");
  }
  return allow("SUBSCRIBER");
}
