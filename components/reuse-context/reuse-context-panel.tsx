"use client";

import { useState } from "react";
import type { CanDeclareReuseContextResult, DeclaredContext, ReuseContextDeclarationView } from "@/lib/reuse-context-declarations";

/**
 * E8S Step 6: the DECLARER-facing UI for E8S Step 5's design — Flows 1, 2,
 * 6, 7, 8, 9. Purely presentational: every action is a caller-supplied
 * callback, this component never calls fetch() itself, so it can be
 * rendered and asserted on via react-dom/server's renderToStaticMarkup
 * exactly like every other report component in this repo (no jsdom, no
 * click simulation — see components/report/similarity-report-papers.tsx's
 * own existing test conventions).
 *
 * Deliberately additive, never a replacement: this component renders
 * nothing about containment/matchedWordCount/score/archiveScore/aiScore —
 * those stay exactly where they already are, in
 * components/report/similarity-report-papers.tsx's existing "Previously
 * submitted content" block. This component is meant to be composed
 * alongside that block, not instead of it (E8S Step 6 requirement 7). Not
 * actually composed there yet — see this phase's own final report for why.
 *
 * Renders nothing (returns null) whenever the current viewer is not
 * eligible to see an "Add context" affordance at all — SELF relationships,
 * a viewer who does not own the submission, or a representation/identity
 * that could not be found. This is what makes "SELF never shows Add
 * context" (test J) and "third party cannot see/act" (test K) true at the
 * UI layer, on top of the same guarantee already enforced server-side by
 * canDeclareReuseContext/declareReuseContext.
 */

const CONTEXT_LABELS: Record<DeclaredContext, string> = {
  SUPERVISOR_COPY: "supervisor copy",
  COAUTHOR_COPY: "coauthor copy",
  INSTITUTIONAL_SUBMISSION: "institutional submission",
  AUTHORIZED_ARCHIVAL_COPY: "authorized archival copy",
  OTHER_AUTHORIZED_REUSE: "authorized reuse",
};

const CONTEXT_FORM_OPTIONS: { value: DeclaredContext; label: string }[] = [
  { value: "SUPERVISOR_COPY", label: "My supervisor submitted this" },
  { value: "COAUTHOR_COPY", label: "A coauthor submitted this" },
  { value: "INSTITUTIONAL_SUBMISSION", label: "This was submitted through my institution/instructor" },
  { value: "AUTHORIZED_ARCHIVAL_COPY", label: "This is an authorized archival copy" },
  { value: "OTHER_AUTHORIZED_REUSE", label: "Other authorized reuse" },
];

/** E8S Step 5 Flow 2's declare form. A separate component so ReuseContextPanel can render it conditionally without holding its own local radio-selection state. */
export function AddContextForm({ onSubmit, onCancel }: { onSubmit: (context: DeclaredContext) => void; onCancel?: () => void }) {
  const [selected, setSelected] = useState<DeclaredContext | null>(null);
  return (
    <form
      className="reuse-context-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected) onSubmit(selected);
      }}
    >
      <p>Why is this content already in TurnitPlus?</p>
      <fieldset>
        {CONTEXT_FORM_OPTIONS.map((option) => (
          <label key={option.value} className="reuse-context-form-option">
            <input
              type="radio"
              name="declaredContext"
              value={option.value}
              checked={selected === option.value}
              onChange={() => setSelected(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <p className="reuse-context-form-note">
        This is <strong>your own claim</strong> — the original submitter will be asked to confirm it. It will not change your score.
      </p>
      <button type="submit" disabled={!selected}>Submit</button>
      {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
    </form>
  );
}

export type ReuseContextOutcome = "REJECTED" | "REVOKED_AFTER_CONFIRMATION" | null;

export function ReuseContextPanel({
  affordance,
  activeDeclaration,
  unresolvable = false,
  lastOutcome = null,
  onDeclare,
  onWithdraw,
}: {
  affordance: CanDeclareReuseContextResult;
  activeDeclaration: ReuseContextDeclarationView | null;
  /** True when the resolved matched_submission_reference_id (or the account behind it) is no longer resolvable — E8S Step 5's Flow 10. Only meaningful while activeDeclaration is SELF_ASSERTED_UNVERIFIED. */
  unresolvable?: boolean;
  /** A one-time, transient outcome to display immediately after an action completes (E8S Step 5's recommended default: no persistent revocation-history UI). Never re-derived from a stored column. */
  lastOutcome?: ReuseContextOutcome;
  onDeclare?: (context: DeclaredContext) => void;
  onWithdraw?: () => void;
}) {
  const [showForm, setShowForm] = useState(false);

  if (activeDeclaration && activeDeclaration.verificationState === "MUTUALLY_CONFIRMED") {
    return (
      <div className="reuse-context-block reuse-context-confirmed">
        <p>
          <strong>Confirmed:</strong> The original submitter has confirmed this is a {CONTEXT_LABELS[activeDeclaration.declaredContext]}.
        </p>
        {onWithdraw && <button type="button" onClick={onWithdraw}>Revoke</button>}
      </div>
    );
  }

  if (activeDeclaration && activeDeclaration.verificationState === "SELF_ASSERTED_UNVERIFIED") {
    return (
      <div className="reuse-context-block reuse-context-unverified">
        <p>
          <strong>Unverified:</strong> You&rsquo;ve indicated this is a {CONTEXT_LABELS[activeDeclaration.declaredContext]}.{" "}
          {unresolvable
            ? "This can no longer be confirmed — the original submission is no longer available."
            : "The original submitter has not confirmed this yet."}
        </p>
        {onWithdraw && <button type="button" onClick={onWithdraw}>Withdraw</button>}
      </div>
    );
  }

  // No active declaration. lastOutcome (if any) is shown once, then the
  // normal baseline/CTA/ambiguous rendering below takes over on next load.
  const outcomeNote = lastOutcome === "REJECTED"
    ? <p className="reuse-context-note reuse-context-outcome">This context was not confirmed by the original submitter.</p>
    : lastOutcome === "REVOKED_AFTER_CONFIRMATION"
      ? <p className="reuse-context-note reuse-context-outcome">This confirmed context was revoked.</p>
      : null;

  if (affordance.canDeclare) {
    return (
      <div className="reuse-context-block">
        {outcomeNote}
        {showForm
          ? <AddContextForm onSubmit={(context) => { setShowForm(false); onDeclare?.(context); }} onCancel={() => setShowForm(false)} />
          : (
            <p className="reuse-context-note">
              <button type="button" className="reuse-context-add-link" onClick={() => setShowForm(true)}>Add context</button>
              {" "}— if this is a supervisor, coauthor, institutional, or otherwise authorized copy, you can say so.
            </p>
          )}
      </div>
    );
  }

  if (affordance.reason === "AMBIGUOUS") {
    return (
      <div className="reuse-context-block">
        {outcomeNote}
        <p className="reuse-context-note reuse-context-ambiguous">
          This content matches multiple prior submissions, so a specific context can&rsquo;t be added yet.
        </p>
      </div>
    );
  }

  // SELF_RELATIONSHIP, NOT_SUBMISSION_OWNER, NO_MATCH_PAIR, IDENTITY_NOT_FOUND,
  // REPRESENTATION_NOT_FOUND, ALREADY_ACTIVE (unreachable here without
  // activeDeclaration, kept for exhaustiveness) -- nothing to show.
  return outcomeNote ? <div className="reuse-context-block">{outcomeNote}</div> : null;
}
