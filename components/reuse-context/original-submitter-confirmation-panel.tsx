"use client";

import type { DeclaredContext, ReuseContextDeclarationView } from "@/lib/reuse-context-declarations";

/**
 * E8S Step 6: the ORIGINAL-submitter-facing UI for E8S Step 5's Flows 3, 4,
 * 5. Renders the reverse-lookup result (lib/reuse-context-declarations.ts's
 * getDeclarationsReferencingSubmission, via GET /api/reuse-context/pending)
 * for one of the viewer's own submissions. Purely presentational, same
 * renderToStaticMarkup-testable convention as reuse-context-panel.tsx.
 *
 * The only information ever rendered here is the bounded
 * ReuseContextDeclarationView shape — declaredContext (an enum) and
 * declaredAt (a date). There is no free-text field anywhere in this
 * feature's schema, so there is structurally nothing here a declarer could
 * use to write a persuasive message to the original submitter (E8S Step
 * 5's own social-engineering defense, §4).
 */

const CONTEXT_LABELS: Record<DeclaredContext, string> = {
  SUPERVISOR_COPY: "supervisor copy",
  COAUTHOR_COPY: "coauthor copy",
  INSTITUTIONAL_SUBMISSION: "institutional submission",
  AUTHORIZED_ARCHIVAL_COPY: "authorized archival copy",
  OTHER_AUTHORIZED_REUSE: "authorized reuse",
};

function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function PendingDeclarationRow({
  declaration,
  justConfirmed,
  onConfirm,
  onReject,
}: {
  declaration: ReuseContextDeclarationView;
  justConfirmed: boolean;
  onConfirm?: (declarationId: number) => void;
  onReject?: (declarationId: number) => void;
}) {
  if (declaration.verificationState === "MUTUALLY_CONFIRMED") {
    return (
      <li className="reuse-context-pending-item reuse-context-pending-confirmed">
        {justConfirmed ? "Confirmed." : `You confirmed this is a ${CONTEXT_LABELS[declaration.declaredContext]}.`}
      </li>
    );
  }

  return (
    <li className="reuse-context-pending-item">
      <p>
        <strong>Someone has indicated a reuse context for this submission.</strong>
      </p>
      <p>
        Claimed context: <em>{capitalize(CONTEXT_LABELS[declaration.declaredContext])}</em><br />
        Declared: {declaration.declaredAt}
      </p>
      <p>This claim has not been verified. You can confirm it if it&rsquo;s accurate, or reject it.</p>
      <button type="button" onClick={() => onConfirm?.(declaration.id)}>Confirm</button>
      <button type="button" onClick={() => onReject?.(declaration.id)}>Reject</button>
    </li>
  );
}

export type PendingActionOutcome = { declarationId: number; outcome: "CONFIRMED" | "REJECTED" } | null;

export function OriginalSubmitterConfirmationPanel({
  pending,
  lastAction = null,
  onConfirm,
  onReject,
}: {
  pending: ReuseContextDeclarationView[];
  /** A one-time, transient outcome to display immediately after Confirm/Reject completes — re-fetched server state (requirement 9) already reflects the real, persistent state; this only softens the immediate UI response. Never stored, never re-derived from a column. */
  lastAction?: PendingActionOutcome;
  onConfirm?: (declarationId: number) => void;
  onReject?: (declarationId: number) => void;
}) {
  // A rejected declaration is revoked server-side, so it no longer appears
  // in `pending` at all on the next fetch (E8S Step 5's own default: no
  // persistent trace) — the transient note below is the only place this
  // outcome is ever shown, and only once.
  const showRejectedNote = lastAction?.outcome === "REJECTED" && !pending.some((d) => d.id === lastAction.declarationId);

  if (pending.length === 0 && !showRejectedNote) return null;
  return (
    <>
      {showRejectedNote && <p className="reuse-context-note reuse-context-outcome">You&rsquo;ve indicated this context is not confirmed.</p>}
      {pending.length > 0 && (
        <ul className="reuse-context-pending-list">
          {pending.map((declaration) => (
            <PendingDeclarationRow
              key={declaration.id}
              declaration={declaration}
              justConfirmed={lastAction?.outcome === "CONFIRMED" && lastAction.declarationId === declaration.id}
              onConfirm={onConfirm}
              onReject={onReject}
            />
          ))}
        </ul>
      )}
    </>
  );
}
