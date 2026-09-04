"use client";

import type { FormEvent } from "react";
import { ShieldCheck, X } from "lucide-react";

/**
 * A3b — the code-entry modal opened from the account page's "Verify email"
 * button (components/account/email-verification-status.tsx). Purely
 * presentational, driven entirely by props from app/page.tsx — same pattern
 * as EmailVerificationStatus, and for the same reason: this repo has no
 * jsdom/click-simulation infra, so tests render this component directly with
 * different prop combinations rather than mounting the full page and
 * clicking through it.
 *
 * stage:
 *   "sending"   -> a code was just requested, request still in flight
 *   "ready"     -> a code exists; the 6-digit input + Verify + Resend are live
 *   "verifying" -> the entered code is being checked
 *   "verified"  -> success
 */
export type EmailVerificationModalStage = "sending" | "ready" | "verifying" | "verified";

export function EmailVerificationModal({
  open,
  stage,
  email,
  code,
  onCodeChange,
  onSubmit,
  onResend,
  onClose,
  error,
  resendCooldownSeconds,
  resending,
}: {
  open: boolean;
  stage: EmailVerificationModalStage;
  email: string;
  code: string;
  onCodeChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onResend: () => void;
  onClose: () => void;
  error: string | null;
  resendCooldownSeconds: number;
  resending: boolean;
}) {
  if (!open) return null;

  const canSubmit = stage === "ready" && code.length === 6;

  return (
    <div className="email-verify-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="email-verify-modal surface-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-verify-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="email-verify-modal-close" aria-label="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>

        {stage === "verified" ? (
          <div className="email-verify-modal-success">
            <ShieldCheck aria-hidden="true" />
            <h2 id="email-verify-modal-title">Email verified</h2>
            <p>{email} is now confirmed.</p>
          </div>
        ) : (
          <>
            <h2 id="email-verify-modal-title">Verify your email</h2>
            <p className="email-verify-modal-lead">
              {stage === "sending" ? (
                <>Sending a 6-digit code to {email}…</>
              ) : (
                <>Enter the 6-digit code sent to {email}.</>
              )}
            </p>

            <form onSubmit={onSubmit}>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                className="email-verify-code-input"
                placeholder="000000"
                aria-label="6-digit verification code"
                value={code}
                disabled={stage === "sending" || stage === "verifying"}
                onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
                autoFocus
              />

              {error && <p className="email-verify-modal-error">{error}</p>}

              <button type="submit" className="button primary email-verify-modal-submit" disabled={!canSubmit}>
                {stage === "verifying" ? "Verifying…" : "Verify"}
              </button>
            </form>

            <button
              type="button"
              className="email-verify-modal-resend"
              onClick={onResend}
              disabled={resendCooldownSeconds > 0 || resending || stage === "sending"}
            >
              {resending
                ? "Resending…"
                : resendCooldownSeconds > 0
                  ? `Resend code (${resendCooldownSeconds}s)`
                  : "Resend code"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
