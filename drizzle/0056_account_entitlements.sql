-- ACCOUNT ACTIVATION (2026-10-24) — manual, owner-granted customer plans. Additive only: four new tables, no
-- existing table, column or row is altered, nothing is backfilled. Nothing reads these tables while the
-- ACCOUNT_ACTIVATION_ENFORCED switch is off (lib/account-entitlements.ts), so an environment can apply this migration
-- before it turns the feature on.
--
-- Every timestamp is INTEGER milliseconds since the Unix epoch (UTC), the same convention as sessions.expires_at, so
-- no stored value depends on a server time zone.
--
-- account_entitlements — at most ONE row per customer account: the plan the owner granted.
--   rooms         how many numbered room slots the customer may upload into (the existing room/slot model,
--                 lib/report-rooms.ts — each room holds one report and frees 24 h after its upload). Not a balance.
--   plan_days     the duration last granted (30/90/180/360).
--   activated_at  when the current continuous plan began (a renewal keeps it; an activation after expiry resets it).
--   expires_at    the exact moment new checks stop: activated_at/previous expiry + plan_days * 86 400 000 ms.
--   status        'active' or 'suspended' (an owner pause: no new checks, reports stay readable).
--   version       incremented by every change — the admin console's optimistic-concurrency token.
CREATE TABLE IF NOT EXISTS account_entitlements (
  user_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  plan_days INTEGER NOT NULL CHECK (plan_days IN (30, 90, 180, 360)),
  rooms INTEGER NOT NULL CHECK (rooms BETWEEN 1 AND 100),
  activated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  suspended_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_entitlements_expires_at ON account_entitlements (expires_at);

-- account_entitlement_events — the append-only audit trail of every admin action, and its idempotency record:
-- operation_id is generated once per confirmation in the admin console, so a repeated click or a retried request
-- finds its own row here and is answered from it instead of being applied twice. target_email / admin_email are
-- snapshots taken when the action ran. Never holds a password, session token or manuscript content.
--   target_email_verified  1/0 = the customer's email was / was NOT verified when the admin acted (0 is only ever
--                          written after the admin explicitly confirmed acting on an unverified account); NULL = unknown.
--   account_deleted        written by account deletion itself (no admin: admin_user_id/admin_email NULL, new_json NULL),
--                          so the audit trail of a deleted account ends with a record of the deletion. Rows here are
--                          kept when the account is deleted: they are the owner's record of what was granted.
CREATE TABLE IF NOT EXISTS account_entitlement_events (
  operation_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  target_email TEXT NOT NULL,
  admin_user_id TEXT,
  admin_email TEXT,
  action TEXT NOT NULL CHECK (action IN ('activate', 'renew', 'adjust_rooms', 'suspend', 'reactivate', 'account_deleted')),
  previous_json TEXT,
  new_json TEXT,
  reason TEXT,
  target_email_verified INTEGER CHECK (target_email_verified IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK ((action = 'account_deleted') = (admin_user_id IS NULL)),
  CHECK (action = 'account_deleted' OR (admin_email IS NOT NULL AND new_json IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_account_entitlement_events_user ON account_entitlement_events (user_id, created_at);

-- account_room_claims — when each (account, room) slot was last claimed by a new upload, by the SERVER clock. While
-- enforcement is on, a room stays unavailable for 24 h from this moment even if its report is deleted or was saved
-- with a back-dated createdAt (saved_reports.report_created_at comes from the client). Written in the same transaction
-- as the upload it records.
CREATE TABLE IF NOT EXISTS account_room_claims (
  user_id TEXT NOT NULL,
  room_number INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, room_number)
);

-- account_check_authorizations — a server-issued, single-use permission for ONE check, so a check that started while
-- the plan was active can still save if the plan expires during the minutes the browser spends analysing it. Issued
-- only while the plan is active and the room is free (POST /api/reports/check-authorization), bound to the account, the
-- room and the SHA-256 of the manuscript's canonical text, valid for a bounded time (expires_at), and consumed in the
-- same transaction as the save it permits (consumed_at, report_id) — so it can never start another check or be
-- replayed for another document. Holds a hash only, never the text.
CREATE TABLE IF NOT EXISTS account_check_authorizations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  room_number INTEGER NOT NULL,
  text_sha256 TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  report_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_check_authorizations_user_room ON account_check_authorizations (user_id, room_number);
