"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, UserX } from "lucide-react";

/**
 * Debug workspace — "Clear account rooms". An admin-only tool to clear the
 * saved reports / room occupancy of ONE other account, selected by exact
 * email. Separate from "Clear my rooms" (components/developer/room-reset.tsx),
 * which is unchanged and only ever targets the signed-in admin.
 *
 * A first click is always a DRY RUN (POST /api/developer/reset-account-rooms
 * { email, dryRun: true }) — zero writes, no token. The dry run returns the
 * server-canonicalized accountEmail. The destructive call then requires the
 * admin to re-type that exact email into a dedicated confirmation field;
 * the request sends { email, dryRun: false, confirmEmail } and the server
 * canonicalizes both the same way and refuses unless they are equal, then
 * re-resolves the account server-side. Editing the target email after a
 * preview drops the preview and forces a fresh one.
 *
 * The browser never sends an account id — the server resolves the target
 * account from the email alone. Rooms are shown 1-indexed to match the
 * product's "Room N" labels.
 */

type AccountResetPlan = {
  accountEmail: string;
  reportsToDelete: number;
  roomsAffected: number[];
};

type PreviewResponse = {
  error?: string;
  found?: boolean;
  accountEmail?: string;
  reportsToDelete?: number;
  roomsAffected?: number[];
};

type DeleteResponse = {
  error?: string;
  accountEmail?: string;
  reportsDeleted?: number;
};

type Phase = "idle" | "checking" | "confirm" | "deleting" | "done";

function displayRooms(rooms: number[]): string {
  if (rooms.length === 0) return "none";
  return rooms.map((room) => room + 1).join(", ");
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

export function DeveloperAccountRoomReset() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<AccountResetPlan | null>(null);
  const [notFoundEmail, setNotFoundEmail] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function resetToIdle() {
    setPhase("idle");
    setPlan(null);
    setConfirmEmail("");
    setError(null);
    setNotFoundEmail(null);
  }

  function onEmailChange(value: string) {
    setEmail(value);
    // A previewed plan is only valid for the email it was previewed with.
    if (phase === "confirm" || phase === "done") resetToIdle();
  }

  async function runPreview() {
    const trimmed = email.trim();
    if (!trimmed) return;
    setPhase("checking");
    setError(null);
    setNotFoundEmail(null);
    setDoneMessage(null);
    try {
      const response = await fetch("/api/developer/reset-account-rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, dryRun: true }),
      });
      const data = (await response.json().catch(() => null)) as PreviewResponse | null;
      if (!response.ok) {
        throw new Error(data?.error || `Preview failed (${response.status})`);
      }
      if (!data || data.found === false) {
        setNotFoundEmail(data?.accountEmail || trimmed);
        setPhase("idle");
        return;
      }
      if (
        typeof data.accountEmail !== "string" ||
        typeof data.reportsToDelete !== "number" ||
        !Array.isArray(data.roomsAffected)
      ) {
        throw new Error("Unexpected preview response");
      }
      setPlan({
        accountEmail: data.accountEmail,
        reportsToDelete: data.reportsToDelete,
        roomsAffected: data.roomsAffected,
      });
      setConfirmEmail("");
      setPhase("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
      setPhase("idle");
    }
  }

  async function runDelete() {
    if (!plan) return;
    setPhase("deleting");
    setError(null);
    try {
      const response = await fetch("/api/developer/reset-account-rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: plan.accountEmail, dryRun: false, confirmEmail }),
      });
      const data = (await response.json().catch(() => null)) as DeleteResponse | null;
      if (!response.ok) {
        throw new Error(data?.error || `Reset failed (${response.status})`);
      }
      const clearedEmail = data?.accountEmail ?? plan.accountEmail;
      const deleted = typeof data?.reportsDeleted === "number" ? data.reportsDeleted : plan.reportsToDelete;
      setDoneMessage(`Rooms cleared for ${clearedEmail}. ${plural(deleted, "report")} deleted.`);
      setPlan(null);
      setConfirmEmail("");
      setPhase("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
      setPhase("confirm");
    }
  }

  const confirmMatches = plan !== null && confirmEmail.trim().toLowerCase() === plan.accountEmail;

  return (
    <div className="admin-debug-tool">
      <div className="admin-debug-tool-heading">
        <UserX size={16} className="admin-card-title-icon" aria-hidden="true" />
        <strong>Clear account rooms</strong>
      </div>
      <p className="admin-card-description">Clear saved reports and occupied rooms for one test account.</p>

      <div className="admin-corpus-toolbar">
        <label>
          Account email
          <input
            type="email"
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
            placeholder="name@example.com"
            aria-label="Account email"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="admin-btn-primary"
          onClick={runPreview}
          disabled={phase === "checking" || phase === "deleting" || email.trim().length === 0}
        >
          {phase === "checking" ? "Checking…" : "Preview account rooms"}
        </button>
      </div>

      {notFoundEmail && (
        <p className="admin-form-error" role="status">
          No account found for {notFoundEmail}.
        </p>
      )}

      {phase === "confirm" && plan && (
        <div className="admin-debug-plan admin-debug-plan--warning">
          <div className="admin-debug-plan-heading">
            <AlertTriangle size={16} aria-hidden="true" />
            <strong>
              {plural(plan.reportsToDelete, "report")} across {plural(plan.roomsAffected.length, "room")} will be deleted.
            </strong>
          </div>
          <p>Rooms affected: {displayRooms(plan.roomsAffected)}</p>
          <p>Accepted / promoted corpus content: not affected.</p>
          <label className="admin-debug-confirm-label">
            Re-enter <code>{plan.accountEmail}</code> to confirm:
            <input
              type="email"
              value={confirmEmail}
              onChange={(event) => setConfirmEmail(event.target.value)}
              placeholder={plan.accountEmail}
              aria-label="Re-enter the target email to confirm"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="admin-dialog-actions admin-dialog-actions--inline">
            <button type="button" onClick={resetToIdle} className="admin-dialog-cancel">
              Cancel
            </button>
            <button
              type="button"
              className="admin-dialog-danger"
              onClick={runDelete}
              disabled={!confirmMatches}
            >
              Delete {plural(plan.reportsToDelete, "report")} for {plan.accountEmail}
            </button>
          </div>
        </div>
      )}

      {phase === "deleting" && <p aria-live="polite" className="admin-corpus-loading">Clearing rooms…</p>}

      {phase === "done" && doneMessage && (
        <p aria-live="polite" className="admin-form-notice admin-form-notice--icon">
          <CheckCircle2 size={15} aria-hidden="true" />
          {doneMessage}
        </p>
      )}

      {error && (
        <p role="alert" className="admin-form-error">
          {error}
        </p>
      )}
    </div>
  );
}
