"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, DoorOpen } from "lucide-react";

/**
 * Debug workspace — "Clear my rooms". A first click is always a DRY RUN
 * (POST /api/developer/reset-rooms { dryRun: true }): it shows how many of
 * the signed-in developer's own saved reports would be deleted and which
 * room slots they occupy, and performs zero writes. Only the explicit
 * "Delete N reports" confirmation button then sends { dryRun: false }.
 *
 * This component never sends an account id — the endpoint derives identity
 * from the session cookie alone (see that route's own header comment) and
 * clears only the caller's own reports. On success it calls router.refresh()
 * so the overview table (a Server Component) re-renders from an empty state.
 *
 * Rooms are shown 1-indexed to match the "Room N" labels used everywhere
 * else in the product (components/reports/report-rooms.tsx); the API speaks
 * the raw 0-indexed saved_reports.room_number.
 */

type ResetPlan = { reportsToDelete: number; roomsAffected: number[] };

type Phase = "idle" | "checking" | "confirm" | "deleting" | "done";

function displayRooms(rooms: number[]): string {
  if (rooms.length === 0) return "none";
  return rooms.map((room) => room + 1).join(", ");
}

export function DeveloperRoomReset() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<ResetPlan | null>(null);
  const [deletedCount, setDeletedCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runDryRun() {
    setPhase("checking");
    setError(null);
    try {
      const response = await fetch("/api/developer/reset-rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      if (!response.ok) throw new Error(`Dry run failed (${response.status})`);
      const data = (await response.json()) as { reportsToDelete: number; roomsAffected: number[] };
      setPlan({ reportsToDelete: data.reportsToDelete, roomsAffected: data.roomsAffected });
      setPhase("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dry run failed");
      setPhase("idle");
    }
  }

  async function runDelete() {
    setPhase("deleting");
    setError(null);
    try {
      const response = await fetch("/api/developer/reset-rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false }),
      });
      if (!response.ok) throw new Error(`Reset failed (${response.status})`);
      const data = (await response.json()) as { reportsDeleted: number };
      setDeletedCount(data.reportsDeleted);
      setPhase("done");
      setPlan(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
      setPhase("confirm");
    }
  }

  function cancel() {
    setPhase("idle");
    setPlan(null);
    setError(null);
  }

  return (
    <div className="admin-debug-tool">
      <div className="admin-debug-tool-heading">
        <DoorOpen size={16} className="admin-card-title-icon" aria-hidden="true" />
        <strong>Clear my rooms</strong>
      </div>
      <p className="admin-card-description">Delete all saved reports from your developer account so you can start testing with empty rooms.</p>

      {(phase === "idle" || phase === "checking") && (
        <button type="button" className="admin-btn-primary" onClick={runDryRun} disabled={phase === "checking"}>
          {phase === "checking" ? "Checking…" : "Clear my rooms"}
        </button>
      )}

      {phase === "confirm" && plan && (
        <div className="admin-debug-plan admin-debug-plan--warning">
          <div className="admin-debug-plan-heading">
            <AlertTriangle size={16} aria-hidden="true" />
            <strong>
              {plan.reportsToDelete} {plan.reportsToDelete === 1 ? "report" : "reports"} across{" "}
              {plan.roomsAffected.length} {plan.roomsAffected.length === 1 ? "room" : "rooms"} will be deleted.
            </strong>
          </div>
          <p>Rooms affected: {displayRooms(plan.roomsAffected)}</p>
          <p>Accepted / promoted corpus content: not affected.</p>
          <div className="admin-dialog-actions admin-dialog-actions--inline">
            <button type="button" onClick={cancel} className="admin-dialog-cancel">
              Cancel
            </button>
            <button type="button" className="admin-dialog-danger" onClick={runDelete}>
              Delete {plan.reportsToDelete} {plan.reportsToDelete === 1 ? "report" : "reports"}
            </button>
          </div>
        </div>
      )}

      {phase === "deleting" && <p aria-live="polite" className="admin-corpus-loading">Clearing rooms…</p>}

      {phase === "done" && (
        <p aria-live="polite" className="admin-form-notice admin-form-notice--icon">
          <CheckCircle2 size={15} aria-hidden="true" />
          Developer rooms cleared.
          {deletedCount !== null && ` (${deletedCount} ${deletedCount === 1 ? "report" : "reports"} deleted.)`}
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
