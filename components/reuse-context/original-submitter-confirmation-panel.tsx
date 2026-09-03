"use client";

import type { ReuseContextEnvelope } from "@/lib/reuse-context-types";
import { REUSE_CONTEXT_LABELS } from "@/lib/reuse-context-labels";

/**
 * ORIGINAL-submitter-facing UI: the reuse-context declarations someone has
 * made against one of the viewer's own submissions.
 *
 *   - `pending[]`   : SELF_ASSERTED_UNVERIFIED — awaiting a confirm / reject
 *                     decision.
 *   - `confirmed[]` : the viewer's own active confirmations — retractable
 *                     with "Revoke confirmation".
 *
 * Purely presentational. The only data shown is the bounded context enum
 * and a date; there is no free-text field anywhere in this feature.
 * Actions are keyed by the opaque session-bound actionRef, never a
 * declaration id. Nothing here implies same owner, same person, or verified
 * authorship, and nothing here changes the similarity score.
 */

export type PendingActionOutcome =
  | { actionRef: string; outcome: "CONFIRMED" | "REJECTED" | "CONFIRMATION_REVOKED" }
  | null;

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function OriginalSubmitterConfirmationPanel({
  pending,
  confirmed,
  lastAction = null,
  onConfirm,
  onReject,
  onRevokeConfirmation,
}: {
  pending: ReuseContextEnvelope["confirm"]["pending"];
  confirmed: ReuseContextEnvelope["confirm"]["confirmed"];
  /** One-time transient outcome shown immediately after an action; the re-fetched envelope is the real answer. Never stored. */
  lastAction?: PendingActionOutcome;
  onConfirm: (actionRef: string) => void;
  onReject: (actionRef: string) => void;
  onRevokeConfirmation: (actionRef: string) => void;
}) {
  const rejectedNote = lastAction?.outcome === "REJECTED" && !pending.some((d) => d.actionRef === lastAction.actionRef);
  const revokedNote =
    lastAction?.outcome === "CONFIRMATION_REVOKED" && !confirmed.some((d) => d.actionRef === lastAction.actionRef);

  if (pending.length === 0 && confirmed.length === 0 && !rejectedNote && !revokedNote) return null;

  return (
    <>
      {rejectedNote && (
        <p className="reuse-context-note reuse-context-outcome">You&rsquo;ve indicated this context is not confirmed.</p>
      )}
      {revokedNote && (
        <p className="reuse-context-note reuse-context-outcome">Your reuse-context confirmation has been retracted. This has no effect on the similarity score.</p>
      )}

      {pending.length > 0 && (
        <ul className="reuse-context-pending-list">
          {pending.map((declaration) => {
            const justConfirmed = lastAction?.outcome === "CONFIRMED" && lastAction.actionRef === declaration.actionRef;
            if (justConfirmed) {
              return (
                <li key={declaration.actionRef} className="reuse-context-pending-item reuse-context-pending-confirmed">Confirmed.</li>
              );
            }
            return (
              <li key={declaration.actionRef} className="reuse-context-pending-item">
                <p><strong>Someone has indicated a reuse context for this submission.</strong></p>
                <p>
                  Claimed context: <em>{capitalize(REUSE_CONTEXT_LABELS[declaration.declaredContext].badge)}</em><br />
                  Declared: {declaration.declaredDate}
                </p>
                <p>This claim has not been verified. You can confirm it if it&rsquo;s accurate, or reject it. It does not change the similarity score either way.</p>
                <button type="button" onClick={() => onConfirm(declaration.actionRef)}>Confirm</button>
                <button type="button" onClick={() => onReject(declaration.actionRef)}>Reject</button>
              </li>
            );
          })}
        </ul>
      )}

      {confirmed.length > 0 && (
        <ul className="reuse-context-confirmed-list">
          {confirmed.map((declaration) => (
            <li key={declaration.actionRef} className="reuse-context-confirmed-item">
              <p>
                You confirmed a reuse context for this submission:{" "}
                <em>{capitalize(REUSE_CONTEXT_LABELS[declaration.declaredContext].badge)}</em>
                {declaration.confirmedDate ? ` on ${declaration.confirmedDate}` : ""}.
              </p>
              <p>Revoking retracts your reuse-context confirmation. It has no effect on the similarity score and makes no claim about who owns the work.</p>
              <button type="button" onClick={() => onRevokeConfirmation(declaration.actionRef)}>Revoke confirmation</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
