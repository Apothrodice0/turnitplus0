"use client";

import { useId, useState } from "react";
import type { DeclaredContext } from "@/lib/reuse-context-declarations";
import type { ReuseContextEnvelope } from "@/lib/reuse-context-types";
import {
  REUSE_CONTEXT_BADGE_CONFIRMED,
  REUSE_CONTEXT_BADGE_UNVERIFIED,
  REUSE_CONTEXT_FORM_OPTIONS,
  REUSE_CONTEXT_LABELS,
  REUSE_CONTEXT_SCORE_UNCHANGED_CONFIRMED,
  REUSE_CONTEXT_SCORE_UNCHANGED_UNVERIFIED,
} from "@/lib/reuse-context-labels";

/**
 * DECLARER-facing UI for one report's reuse-context state. Purely
 * presentational — every action is a caller-supplied callback, so this
 * renders and asserts via react-dom/server exactly like the other report
 * components.
 *
 * Driven entirely by the bounded, id-free `declare` envelope
 * (lib/reuse-context-types.ts). It never reads report.historicalSubmissionMatch
 * (admin-only) — an ordinary allowlisted user with a real PRIOR_SUBMISSION
 * match sees the CTA and state here.
 *
 * Copy rules: the unverified badge/explanation never use "authorized",
 * "verified", or "confirmed" as affirmative descriptors, and never imply
 * same owner / same person / SELF / verified authorship / plagiarism-free /
 * removed from score. The one confirmed sentence
 * (REUSE_CONTEXT_SCORE_UNCHANGED_CONFIRMED) is always shown on a confirmed
 * row and is plain body text, never hover-only.
 */

export type ReuseContextOutcome = "REJECTED" | "WITHDRAWN" | null;

function AddContextForm({ onSubmit, onCancel }: { onSubmit: (context: DeclaredContext) => void; onCancel: () => void }) {
  const [selected, setSelected] = useState<DeclaredContext | null>(null);
  const groupName = useId();
  return (
    <form
      className="reuse-context-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected) onSubmit(selected);
      }}
    >
      <fieldset>
        <legend>Why is this content already in TurnitPlus?</legend>
        {REUSE_CONTEXT_FORM_OPTIONS.map((option) => (
          <label key={option.value} className="reuse-context-form-option">
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={selected === option.value}
              onChange={() => setSelected(option.value)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <p className="reuse-context-form-note">
        This is your own claim. The original submitter will be asked to confirm it. It will not change your similarity score.
      </p>
      <button type="submit" disabled={!selected}>Add context</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function ActiveDeclarationRow({
  declaration,
  onWithdraw,
}: {
  declaration: ReuseContextEnvelope["declare"]["activeDeclarations"][number];
  onWithdraw: (actionRef: string) => void;
}) {
  const label = REUSE_CONTEXT_LABELS[declaration.declaredContext];
  if (declaration.state === "MUTUALLY_CONFIRMED") {
    return (
      <div className="reuse-context-block reuse-context-confirmed">
        <p className="reuse-context-badge"><strong>{REUSE_CONTEXT_BADGE_CONFIRMED}</strong></p>
        <p>
          {label.badge}. The original submitting account confirmed this reuse context
          {declaration.confirmedDate ? ` on ${declaration.confirmedDate}` : ""}.
        </p>
        <p>{REUSE_CONTEXT_SCORE_UNCHANGED_CONFIRMED}</p>
        {!declaration.isCurrent && (
          <p className="reuse-context-note">This applies to another matching prior submission on this report.</p>
        )}
        <button type="button" onClick={() => onWithdraw(declaration.actionRef)}>Withdraw</button>
      </div>
    );
  }
  return (
    <div className="reuse-context-block reuse-context-unverified">
      <p className="reuse-context-badge"><strong>{REUSE_CONTEXT_BADGE_UNVERIFIED}</strong></p>
      <p>
        You indicated this is {label.awaitingPhrase}. The original submitter has not confirmed this.{" "}
        {REUSE_CONTEXT_SCORE_UNCHANGED_UNVERIFIED}
      </p>
      {!declaration.isCurrent && (
        <p className="reuse-context-note">This applies to another matching prior submission on this report.</p>
      )}
      <button type="button" onClick={() => onWithdraw(declaration.actionRef)}>Withdraw</button>
    </div>
  );
}

export function ReuseContextPanel({
  declare,
  outcome = null,
  onDeclare,
  onWithdraw,
}: {
  declare: ReuseContextEnvelope["declare"];
  /** A one-time transient note shown once after an action completes. Never re-derived from a column. */
  outcome?: ReuseContextOutcome;
  onDeclare: (context: DeclaredContext) => void;
  onWithdraw: (actionRef: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);

  const outcomeNote = outcome === "REJECTED"
    ? <p className="reuse-context-note reuse-context-outcome">This context was not confirmed by the original submitter.</p>
    : outcome === "WITHDRAWN"
      ? <p className="reuse-context-note reuse-context-outcome">This context is no longer active.</p>
      : null;

  const hasCurrentActive = declare.activeDeclarations.some((d) => d.isCurrent);

  return (
    <div className="reuse-context-panel">
      {outcomeNote}

      {declare.activeDeclarations.map((declaration) => (
        <ActiveDeclarationRow key={declaration.actionRef} declaration={declaration} onWithdraw={onWithdraw} />
      ))}

      {declare.canDeclare && !hasCurrentActive && (
        <div className="reuse-context-block">
          {showForm ? (
            <AddContextForm
              onSubmit={(context) => { setShowForm(false); onDeclare(context); }}
              onCancel={() => setShowForm(false)}
            />
          ) : (
            <p className="reuse-context-note">
              Have a legitimate reason for this match?{" "}
              <button type="button" className="reuse-context-add-link" onClick={() => setShowForm(true)}>Add context</button>
            </p>
          )}
        </div>
      )}

      {!declare.canDeclare && !hasCurrentActive && declare.unavailableReason === "MULTIPLE_SOURCES" && (
        <div className="reuse-context-block">
          <p className="reuse-context-note reuse-context-ambiguous">
            This content matches more than one TurnitPlus reference source, so a specific context can&rsquo;t be added yet.
          </p>
        </div>
      )}
    </div>
  );
}
