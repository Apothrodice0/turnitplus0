"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, Info, Loader2, PauseCircle, PlayCircle, RefreshCw, Search, SlidersHorizontal, TriangleAlert, UserCheck } from "lucide-react";
import {
  formatPlanDate,
  formatPlanDateTime,
  MAX_PLAN_DAYS,
  MAX_PLAN_ROOMS,
  MIN_PLAN_DAYS,
  MIN_PLAN_ROOMS,
  PLAN_DURATION_PRESETS,
  PLAN_ROOM_PRESETS,
  type Entitlement,
  type PlanState,
} from "@/lib/account-plan";

/**
 * Admin → Account Activation console. Everything it shows comes from the admin-only routes under
 * /api/admin/account-activation, which enforce the admin session and validate every value themselves — this
 * component only collects input and shows the server's answers. Dates are the server's (UTC).
 *
 * Flow: email + duration + rooms -> "Activate Account" -> exact account lookup -> server preview (dry run) ->
 * confirmation dialog -> commit with a per-confirmation operation id, the reviewed plan version and the reviewed
 * account id (the plan is bound to that account, never re-targeted by email). Only a verified account can be given
 * access; the server refuses an unverified one and this console says so before asking. The confirm
 * button is disabled while the request is in flight, and a retry after a lost answer re-sends the SAME operation id,
 * which the server answers from its record instead of applying the change twice.
 */

type Action = "activate" | "renew" | "adjust_rooms" | "suspend" | "reactivate";

type AccountSummary = { userId: string; email: string; username: string; registeredAt: number | null; emailVerified: boolean | null; isAdmin: boolean };
type ActivationEvent = {
  operationId: string;
  action: Action;
  adminEmail: string;
  previous: Entitlement | null;
  next: Entitlement;
  reason: string | null;
  targetEmailVerified: boolean | null;
  createdAt: number;
};
type Lookup =
  | { found: false; email: string }
  | {
      found: true;
      account: AccountSummary;
      entitlement: Entitlement | null;
      state: PlanState;
      roomsBusy: number;
      history: ActivationEvent[];
      enforcementStartedAt: number | null;
      legacyGraceEndsAt: number | null;
      serverNow: number;
    };
type Preview = {
  action: Action;
  account: AccountSummary;
  previous: Entitlement | null;
  previousState: PlanState;
  next: Entitlement;
  nextState: PlanState;
  extensionStartsAt: number | null;
  reason: string | null;
  busyRoomsAboveNewCount: number;
  expectedVersion: number;
  expectedUserId: string;
  serverNow: number;
};
type ListRow = { userId: string; email: string; username: string; emailVerified: boolean | null; planDays: number; activatedAt: number; expiresAt: number; rooms: number; roomsAvailable: number; state: PlanState };
type ListData = { rows: ListRow[]; total: number; page: number; pageSize: number };

const ACTION_TITLE: Record<Action, string> = {
  activate: "Activate account",
  renew: "Renew / extend plan",
  adjust_rooms: "Adjust rooms",
  suspend: "Suspend plan",
  reactivate: "Reactivate plan",
};
const ACTION_DONE: Record<Action, string> = {
  activate: "Account activated successfully",
  renew: "Plan renewed successfully",
  adjust_rooms: "Rooms updated successfully",
  suspend: "Plan suspended",
  reactivate: "Plan reactivated successfully",
};
const STATE_LABEL: Record<PlanState, string> = { none: "No plan", active: "Active", expired: "Expired", suspended: "Suspended" };

async function postJson<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string; code?: string }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    const data = (await response.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
    if (!response.ok) return { ok: false, status: response.status, error: data?.error ?? `Request failed (${response.status}).`, code: data?.code };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, status: 0, error: "No answer from the server. Check your connection and try again." };
  }
}

function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseDays(raw: string): number | null {
  if (!/^\d{1,4}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= MIN_PLAN_DAYS && value <= MAX_PLAN_DAYS ? value : null;
}

const UNVERIFIED_MESSAGE = "This customer has not verified their email address yet. Ask them to verify it from their TurnitPlus account, then look them up again.";

function parseRooms(raw: string): number | null {
  if (!/^\d{1,4}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= MIN_PLAN_ROOMS && value <= MAX_PLAN_ROOMS ? value : null;
}

function StateBadge({ state }: { state: PlanState }) {
  const variant = state === "active" ? "positive" : state === "suspended" ? "warning" : state === "expired" ? "negative" : "neutral";
  return <span className={`admin-status-badge admin-status-badge--${variant}`}>{STATE_LABEL[state]}</span>;
}

function VerifiedBadge({ verified }: { verified: boolean | null }) {
  if (verified === null) return <span className="admin-status-badge admin-status-badge--neutral">Unknown</span>;
  return verified
    ? <span className="admin-status-badge admin-status-badge--positive">Verified</span>
    : <span className="admin-status-badge admin-status-badge--warning">Not verified</span>;
}

export function AccountActivationConsole({ enforcement }: { enforcement: boolean }) {
  const [email, setEmail] = useState("");
  /** A preset (number) or "custom" (then daysInput holds the typed number of days). */
  const [duration, setDuration] = useState<number | "custom" | null>(null);
  const [daysInput, setDaysInput] = useState("");
  const [roomsInput, setRoomsInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "lookup" | "preview">(null);

  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [dialog, setDialog] = useState<{
    preview: Preview;
    operationId: string;
    reason: string;
    submitting: boolean;
    error: string | null;
    input: { action: Action; planDays?: number; rooms?: number };
  } | null>(null);
  const [success, setSuccess] = useState<{ action: Action; event: ActivationEvent; account: AccountSummary; state: PlanState; replayed: boolean } | null>(null);

  const [listQuery, setListQuery] = useState("");
  const [listFilter, setListFilter] = useState<"all" | "active" | "expired" | "suspended">("all");
  const [listPage, setListPage] = useState(1);
  const [list, setList] = useState<ListData | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [listReload, setListReload] = useState(0);
  const accountCardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    const params = new URLSearchParams({ q: listQuery, filter: listFilter, page: String(listPage) });
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/admin/account-activation/accounts?${params}`, { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as (ListData & { error?: string }) | null;
        if (cancelled) return;
        if (!response.ok || !data) {
          setListError(data?.error ?? `Could not load customers (${response.status}).`);
        } else {
          setList(data);
          setListError(null);
        }
      } catch {
        if (!cancelled) setListError("Could not load customers. Check your connection.");
      } finally {
        if (!cancelled) setListLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [listQuery, listFilter, listPage, listReload]);

  const runLookup = useCallback(async (targetEmail: string): Promise<Lookup | null> => {
    setBusy("lookup");
    setLookupError(null);
    const result = await postJson<Lookup>("/api/admin/account-activation/lookup", { email: targetEmail });
    setBusy(null);
    if (!result.ok) {
      setLookup(null);
      setLookupError(result.error);
      return null;
    }
    setLookup(result.data);
    return result.data;
  }, []);

  async function openPreview(input: { action: Action; planDays?: number; rooms?: number }, targetEmail: string) {
    setBusy("preview");
    setFormError(null);
    const result = await postJson<{ preview: Preview }>("/api/admin/account-activation/apply", { email: targetEmail, dryRun: true, ...input });
    setBusy(null);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setDialog({ preview: result.data.preview, operationId: newOperationId(), reason: "", submitting: false, error: null, input });
  }

  function validateEmail(): string | null {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setFormError("Enter the customer's registered email, like customer@example.com.");
      return null;
    }
    return value;
  }

  async function onFind(event?: FormEvent) {
    event?.preventDefault();
    setSuccess(null);
    setFormError(null);
    const target = validateEmail();
    if (target) await runLookup(target);
  }

  async function onPrimary() {
    setSuccess(null);
    setFormError(null);
    const target = validateEmail();
    if (!target) return;
    if (duration === null) return setFormError(`Choose a plan duration: ${PLAN_DURATION_PRESETS.join(", ")} days, or a custom number of days.`);
    const planDays = duration === "custom" ? parseDays(daysInput) : duration;
    if (planDays === null) return setFormError(`Custom duration must be a whole number of days from ${MIN_PLAN_DAYS} to ${MAX_PLAN_DAYS}.`);
    const rooms = parseRooms(roomsInput);
    const current = lookup && lookup.found && lookup.account.email === target.toLowerCase() ? lookup : null;
    const renewing = current?.entitlement && (current.state === "active" || current.state === "suspended");
    if (rooms === null && !(renewing && roomsInput.trim() === "")) {
      return setFormError(`Number of Rooms must be a whole number from ${MIN_PLAN_ROOMS} to ${MAX_PLAN_ROOMS}.`);
    }

    const found = current ?? (await runLookup(target));
    if (!found) return;
    if (!found.found) return;
    if (found.account.isAdmin) return setFormError("This is an administrator account. Administrators are never restricted and do not need activation.");
    if (found.account.emailVerified !== true) return setFormError(UNVERIFIED_MESSAGE);
    if (!current && found.entitlement && (found.state === "active" || found.state === "suspended")) {
      // Never silently turn an activation into something else: show the existing plan first.
      accountCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return setFormError(`This account already has a plan until ${formatPlanDate(found.entitlement.expiresAt)}. Review it below, then use Renew / Extend.`);
    }
    const action: Action = found.entitlement && (found.state === "active" || found.state === "suspended") ? "renew" : "activate";
    await openPreview({ action, planDays, ...(rooms !== null ? { rooms } : {}) }, target);
  }

  async function onSecondary(action: "adjust_rooms" | "suspend" | "reactivate") {
    if (!lookup || !lookup.found) return;
    setSuccess(null);
    setFormError(null);
    if (action === "adjust_rooms") {
      const rooms = parseRooms(roomsInput);
      if (rooms === null) return setFormError(`Enter the corrected Number of Rooms (${MIN_PLAN_ROOMS}–${MAX_PLAN_ROOMS}), then choose Adjust rooms.`);
      return openPreview({ action, rooms }, lookup.account.email);
    }
    if (action === "reactivate" && lookup.account.emailVerified !== true) return setFormError(UNVERIFIED_MESSAGE);
    return openPreview({ action }, lookup.account.email);
  }

  async function onConfirm() {
    if (!dialog || dialog.submitting) return;
    const reasonRequired = dialog.preview.action === "adjust_rooms" || dialog.preview.action === "suspend";
    if (reasonRequired && dialog.reason.trim().length < 3) {
      setDialog({ ...dialog, error: "Please write a short reason for this change." });
      return;
    }
    const sent = dialog;
    setDialog({ ...sent, submitting: true, error: null });
    const result = await postJson<{ outcome: "applied" | "replayed"; account: AccountSummary; event: ActivationEvent; state: PlanState }>(
      "/api/admin/account-activation/apply",
      {
        email: sent.preview.account.email,
        dryRun: false,
        ...sent.input,
        reason: sent.reason.trim() || undefined,
        operationId: sent.operationId,
        expectedVersion: sent.preview.expectedVersion,
        expectedUserId: sent.preview.expectedUserId,
      },
    );
    if (!result.ok) {
      // A lost answer keeps the same operation id, so "Confirm" again can never apply the change twice.
      setDialog({ ...sent, submitting: false, error: result.status === 0 ? `${result.error} Confirming again is safe — it will not apply the change twice.` : result.error });
      return;
    }
    setDialog(null);
    setSuccess({ action: result.data.event.action, event: result.data.event, account: result.data.account, state: result.data.state, replayed: result.data.outcome === "replayed" });
    setRoomsInput("");
    await runLookup(sent.preview.account.email);
    setListReload((n) => n + 1);
  }

  function openFromList(rowEmail: string) {
    setEmail(rowEmail);
    setSuccess(null);
    setFormError(null);
    void runLookup(rowEmail).then(() => accountCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const found = lookup && lookup.found ? lookup : null;
  const hasCurrentPlan = Boolean(found?.entitlement && (found.state === "active" || found.state === "suspended"));
  const primaryLabel = hasCurrentPlan && found?.account.email === email.trim().toLowerCase() ? "Renew / Extend" : "Activate Account";

  return (
    <div className="aa-console">
      {!enforcement && (
        <p className="aa-banner" role="note">
          <Info aria-hidden="true" />
          <span>
            <strong>Enforcement is off in this environment.</strong> Plans you grant here are recorded, but customers are not
            restricted by them until <code>ACCOUNT_ACTIVATION_ENFORCED</code> is turned on.
          </span>
        </p>
      )}

      <section className="admin-card aa-form-card" aria-labelledby="aa-form-title">
        <h2 id="aa-form-title">Activate or renew a subscription</h2>
        <form className="aa-form" onSubmit={onFind} noValidate>
          <label className="aa-field">
            <span>Customer Email</span>
            <div className="aa-email-row">
              <input
                type="email"
                inputMode="email"
                autoComplete="off"
                placeholder="customer@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFormError(null);
                }}
                maxLength={254}
                aria-describedby="aa-email-hint"
              />
              <button type="submit" className="aa-button aa-button-secondary" disabled={busy !== null}>
                {busy === "lookup" ? <Loader2 className="aa-spin" aria-hidden="true" /> : <Search aria-hidden="true" />} Find account
              </button>
            </div>
            <small id="aa-email-hint">The email the customer registered with. The account must already exist and its email must be verified.</small>
          </label>

          <fieldset className="aa-field aa-durations">
            <legend>Plan Duration</legend>
            <div className="aa-segmented" role="radiogroup" aria-label="Plan Duration">
              {[...PLAN_DURATION_PRESETS, "custom" as const].map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={duration === option}
                  className={`aa-segment${duration === option ? " aa-segment-selected" : ""}`}
                  onClick={() => {
                    setDuration(option);
                    setFormError(null);
                  }}
                >
                  {option === "custom" ? "Custom" : `${option} days`}
                </button>
              ))}
            </div>
            {duration === "custom" && (
              <label className="aa-custom-days">
                <span>Number of days</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={MIN_PLAN_DAYS}
                  max={MAX_PLAN_DAYS}
                  step={1}
                  placeholder="e.g. 45"
                  value={daysInput}
                  onChange={(event) => {
                    setDaysInput(event.target.value);
                    setFormError(null);
                  }}
                />
                <small>Any whole number of days from {MIN_PLAN_DAYS} to {MAX_PLAN_DAYS}.</small>
              </label>
            )}
          </fieldset>

          <label className="aa-field aa-rooms">
            <span>Number of Rooms</span>
            <div className="aa-segmented aa-room-presets" role="group" aria-label="Room presets">
              {PLAN_ROOM_PRESETS.map((rooms) => (
                <button
                  key={rooms}
                  type="button"
                  aria-pressed={roomsInput.trim() === String(rooms)}
                  className={`aa-segment${roomsInput.trim() === String(rooms) ? " aa-segment-selected" : ""}`}
                  onClick={() => {
                    setRoomsInput(String(rooms));
                    setFormError(null);
                  }}
                >
                  {rooms}
                </button>
              ))}
            </div>
            <input
              type="number"
              inputMode="numeric"
              min={MIN_PLAN_ROOMS}
              max={MAX_PLAN_ROOMS}
              step={1}
              placeholder="e.g. 10"
              value={roomsInput}
              onChange={(event) => {
                setRoomsInput(event.target.value);
                setFormError(null);
              }}
            />
            <small>Choose a preset or type any number ({MIN_PLAN_ROOMS}–{MAX_PLAN_ROOMS}). Each room takes one document and is free again 24 hours after its upload.{hasCurrentPlan ? " Leave empty to keep the current rooms when renewing." : ""}</small>
          </label>

          {formError && <p className="admin-form-error" role="alert">{formError}</p>}
          {lookupError && <p className="admin-form-error" role="alert">{lookupError}</p>}

          <div className="aa-form-actions">
            <button type="button" className="aa-button aa-button-primary" onClick={() => void onPrimary()} disabled={busy !== null}>
              {busy === "preview" ? <Loader2 className="aa-spin" aria-hidden="true" /> : primaryLabel === "Activate Account" ? <UserCheck aria-hidden="true" /> : <RefreshCw aria-hidden="true" />} {primaryLabel}
            </button>
          </div>
        </form>
      </section>

      {success && (
        <section className="admin-card aa-success" role="status" aria-live="polite">
          <CheckCircle2 aria-hidden="true" />
          <div>
            <h2>{ACTION_DONE[success.action]}</h2>
            {success.replayed && <p>This change had already been applied — nothing was applied twice.</p>}
            <p>
              <strong>{success.account.email}</strong> · {success.event.next.planDays}-day plan · {success.event.next.rooms} rooms ·{" "}
              {STATE_LABEL[success.state]} until {formatPlanDateTime(success.event.next.expiresAt)}
            </p>
          </div>
        </section>
      )}

      {lookup && !lookup.found && (
        <section className="admin-card aa-not-found" role="status">
          <TriangleAlert aria-hidden="true" />
          <p><strong>No account found for this email. Ask the customer to register first.</strong> ({lookup.email})</p>
        </section>
      )}

      {found && (
        <section className="admin-card aa-account" ref={accountCardRef} aria-labelledby="aa-account-title">
          <div className="aa-account-head">
            <div>
              <h2 id="aa-account-title">{found.account.email}</h2>
              <p>{found.account.username}{found.account.registeredAt ? ` · registered ${formatPlanDate(found.account.registeredAt)}` : ""}</p>
            </div>
            <div className="aa-badges">
              <VerifiedBadge verified={found.account.emailVerified} />
              {found.account.isAdmin ? <span className="admin-status-badge admin-status-badge--info">Administrator</span> : <StateBadge state={found.state} />}
            </div>
          </div>

          {!found.account.isAdmin && found.account.emailVerified !== true && (
            <div className="aa-unverified-warning" role="note">
              <TriangleAlert aria-hidden="true" />
              <div>
                <strong>Email not verified — cannot be activated yet</strong>
                <span>
                  The customer has not confirmed this address, so TurnitPlus will not activate, renew or reactivate a plan for it. Ask the
                  customer to verify it from their Account page (Verify email), then look them up again.
                </span>
              </div>
            </div>
          )}
          {!found.account.isAdmin && found.legacyGraceEndsAt !== null && (
            <p className="aa-note">
              <Info aria-hidden="true" />{" "}
              {found.legacyGraceEndsAt > found.serverNow
                ? `Existing account: free access (10 rooms, 10 uploads per day) continues until ${formatPlanDateTime(found.legacyGraceEndsAt)} unless a plan is active.`
                : `Existing account: free access ended ${formatPlanDateTime(found.legacyGraceEndsAt)}.`}
            </p>
          )}
          {found.account.isAdmin && <p className="aa-note"><Info aria-hidden="true" /> Administrator accounts are never restricted and do not need activation.</p>}

          {found.entitlement ? (
            <div className="admin-metric-grid aa-metrics">
              <div className="admin-metric-tile"><div className="admin-metric-tile-label">Plan</div><div className="admin-metric-tile-value">{found.entitlement.planDays} days</div></div>
              <div className="admin-metric-tile"><div className="admin-metric-tile-label">Activated</div><div className="admin-metric-tile-value aa-date">{formatPlanDate(found.entitlement.activatedAt)}</div></div>
              <div className="admin-metric-tile">
                <div className="admin-metric-tile-label">{found.state === "expired" ? "Expired" : "Expires"}</div>
                <div className="admin-metric-tile-value aa-date">{formatPlanDate(found.entitlement.expiresAt)}</div>
                <div className="admin-metric-tile-sub">{formatPlanDateTime(found.entitlement.expiresAt)}</div>
              </div>
              <div className="admin-metric-tile">
                <div className="admin-metric-tile-label">Rooms</div>
                <div className="admin-metric-tile-value">{found.state === "active" ? found.entitlement.rooms - found.roomsBusy : 0} / {found.entitlement.rooms}</div>
                <div className="admin-metric-tile-sub">available now / allocated · {found.roomsBusy} in use</div>
              </div>
            </div>
          ) : (
            !found.account.isAdmin && <p className="aa-empty">No plan yet. Choose a duration and rooms above, then Activate Account.</p>
          )}

          {found.entitlement && !found.account.isAdmin && (
            <div className="aa-secondary-actions">
              <button type="button" className="aa-button aa-button-secondary" onClick={() => void onSecondary("adjust_rooms")} disabled={busy !== null}>
                <SlidersHorizontal aria-hidden="true" /> Adjust rooms
              </button>
              {found.state === "active" && (
                <button type="button" className="aa-button aa-button-warning" onClick={() => void onSecondary("suspend")} disabled={busy !== null}>
                  <PauseCircle aria-hidden="true" /> Suspend
                </button>
              )}
              {found.state === "suspended" && (
                <button type="button" className="aa-button aa-button-secondary" onClick={() => void onSecondary("reactivate")} disabled={busy !== null}>
                  <PlayCircle aria-hidden="true" /> Reactivate
                </button>
              )}
            </div>
          )}

          {found.history.length > 0 && (
            <details className="admin-collapsible aa-history">
              <summary>Plan history ({found.history.length})</summary>
              <div className="admin-collapsible-body">
                <ol className="aa-history-list">
                  {found.history.map((event) => (
                    <li key={event.operationId}>
                      <strong>{ACTION_TITLE[event.action]}</strong> · {formatPlanDateTime(event.createdAt)} · by {event.adminEmail}
                      <span>
                        {event.next.planDays} days · {event.previous && event.previous.rooms !== event.next.rooms ? `${event.previous.rooms} → ` : ""}{event.next.rooms} rooms ·
                        until {formatPlanDate(event.next.expiresAt)}{event.reason ? ` · “${event.reason}”` : ""}
                        {event.targetEmailVerified === false ? " · email was unverified" : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          )}
        </section>
      )}

      <section className="admin-card aa-list" aria-labelledby="aa-list-title">
        <h2 id="aa-list-title">Customer subscriptions</h2>
        <div className="admin-corpus-toolbar aa-list-toolbar">
          <label>
            Search by email
            <input
              type="search"
              placeholder="name@ or domain"
              value={listQuery}
              onChange={(event) => {
                setListQuery(event.target.value);
                setListPage(1);
              }}
            />
          </label>
          <label>
            Status
            <select
              value={listFilter}
              onChange={(event) => {
                setListFilter(event.target.value as typeof listFilter);
                setListPage(1);
              }}
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="expired">Expired</option>
              <option value="suspended">Suspended</option>
            </select>
          </label>
        </div>
        {listError && <p className="admin-form-error" role="alert">{listError}</p>}
        {listLoading && !list && <p className="admin-corpus-loading">Loading…</p>}
        {list && list.rows.length === 0 && !listLoading && <p className="admin-corpus-empty">No subscriptions match.</p>}
        {list && list.rows.length > 0 && (
          <>
            <div className="admin-table-scroll">
              <table className="developer-table aa-table">
                <thead>
                  <tr>
                    <th>Customer email</th>
                    <th>Verified</th>
                    <th>Plan</th>
                    <th>Activated</th>
                    <th>Expires</th>
                    <th>Rooms</th>
                    <th>Available</th>
                    <th>Status</th>
                    <th aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((row) => (
                    <tr key={row.userId}>
                      <td className="aa-email-cell">{row.email}</td>
                      <td><VerifiedBadge verified={row.emailVerified} /></td>
                      <td>{row.planDays} days</td>
                      <td>{formatPlanDate(row.activatedAt)}</td>
                      <td>{formatPlanDate(row.expiresAt)}</td>
                      <td>{row.rooms}</td>
                      <td>{row.roomsAvailable}</td>
                      <td><StateBadge state={row.state} /></td>
                      <td><button type="button" className="aa-link-button" onClick={() => openFromList(row.email)}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-corpus-pager">
              <button type="button" disabled={list.page <= 1 || listLoading} onClick={() => setListPage((p) => Math.max(1, p - 1))}>Previous</button>
              <span>Page {list.page} of {Math.max(1, Math.ceil(list.total / list.pageSize))} · {list.total} customer{list.total === 1 ? "" : "s"}</span>
              <button type="button" disabled={list.page * list.pageSize >= list.total || listLoading} onClick={() => setListPage((p) => p + 1)}>Next</button>
            </div>
          </>
        )}
      </section>

      {dialog && (
        <div className="admin-dialog-backdrop">
          <div role="dialog" aria-modal="true" aria-labelledby="aa-dialog-title" className="aa-dialog">
            <h2 id="aa-dialog-title">{ACTION_TITLE[dialog.preview.action]}?</h2>
            <p>Check the details. Nothing changes until you confirm.</p>
            <ConfirmationSummary preview={dialog.preview} />
            <label>
              Reason {dialog.preview.action === "adjust_rooms" || dialog.preview.action === "suspend" ? "(required)" : "(optional)"}
              <textarea
                value={dialog.reason}
                maxLength={500}
                placeholder={dialog.preview.action === "activate" || dialog.preview.action === "renew" ? "e.g. Paid via WhatsApp, 24 Oct" : "Short explanation for the record"}
                onChange={(event) => setDialog({ ...dialog, reason: event.target.value, error: null })}
                disabled={dialog.submitting}
              />
            </label>
            {dialog.error && <p role="alert" className="admin-form-error">{dialog.error}</p>}
            <div className="admin-dialog-actions">
              <button type="button" className="admin-dialog-cancel" onClick={() => setDialog(null)} disabled={dialog.submitting}>Cancel</button>
              <button
                type="button"
                className={dialog.preview.action === "suspend" ? "admin-dialog-danger" : "aa-button aa-button-primary"}
                onClick={() => void onConfirm()}
                disabled={dialog.submitting}
              >
                {dialog.submitting ? <><Loader2 className="aa-spin" aria-hidden="true" /> Saving…</> : `Confirm ${dialog.preview.action === "activate" ? "activation" : ACTION_TITLE[dialog.preview.action].toLowerCase()}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmationSummary({ preview }: { preview: Preview }) {
  const { previous, next } = preview;
  const kind =
    preview.action === "activate"
      ? previous
        ? `New activation (previous plan ${preview.previousState === "expired" ? `expired ${formatPlanDate(previous.expiresAt)}` : "replaced"})`
        : "New activation"
      : preview.action === "renew"
        ? "Renewal — the new days are added after the current expiry"
        : preview.action === "adjust_rooms"
          ? "Room adjustment — dates unchanged"
          : preview.action === "suspend"
            ? "Suspension — no new checks until reactivated; reports stay readable; the expiry date does not move"
            : "Reactivation — the original expiry date applies";
  const rows: Array<[string, string]> = [
    ["Customer email", preview.account.email],
    ["Customer", preview.account.username],
    ["Email verification", preview.account.emailVerified === null ? "Unknown" : preview.account.emailVerified ? "Verified" : "Not verified"],
    ["Type", kind],
    ["Plan duration", preview.action === "activate" || preview.action === "renew" ? `${next.planDays} days` : `${next.planDays} days (unchanged)`],
    ["Number of rooms", previous && previous.rooms !== next.rooms ? `${previous.rooms} → ${next.rooms}` : `${next.rooms}`],
    ["Activation date", formatPlanDateTime(next.activatedAt)],
    [
      "Expiration date",
      previous && previous.expiresAt !== next.expiresAt && preview.action !== "activate"
        ? `${formatPlanDateTime(previous.expiresAt)} → ${formatPlanDateTime(next.expiresAt)}`
        : formatPlanDateTime(next.expiresAt),
    ],
  ];
  if (preview.extensionStartsAt !== null) rows.push(["Extension starts", formatPlanDateTime(preview.extensionStartsAt)]);
  return (
    <>
      <dl className="aa-summary">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {preview.action === "activate" && (
        <p className="aa-summary-note">The exact activation time is taken from the server clock when you confirm.</p>
      )}
      {preview.busyRoomsAboveNewCount > 0 && (
        <p className="aa-summary-note aa-summary-warning">
          <TriangleAlert aria-hidden="true" /> {preview.busyRoomsAboveNewCount} room{preview.busyRoomsAboveNewCount === 1 ? "" : "s"} above the new
          count {preview.busyRoomsAboveNewCount === 1 ? "holds" : "hold"} a current report. Those reports stay saved and visible; the rooms just
          won&apos;t accept new checks.
        </p>
      )}
    </>
  );
}
