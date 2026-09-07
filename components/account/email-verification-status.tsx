"use client";

import { ShieldCheck, TriangleAlert } from "lucide-react";

/**
 * The account page's email-verification line, extracted so the exact render
 * path can be exercised in isolation (see tests/account-page-email-verification-
 * render.test.mjs). Purely presentational — it renders from `status` alone and
 * knows nothing about the profile: an authenticated account shows this control
 * whether or not it has an identity profile.
 *
 *   status = "unverified"  ->  "Email not verified" + a "Verify email" button
 *   status = "verified"    ->  "Email verified"
 *   status = null          ->  nothing (state not yet hydrated from /api/auth/me)
 */
export type EmailVerificationUiStatus = "verified" | "unverified" | null;

export function EmailVerificationStatus({
  status,
  onVerify,
  sending,
  notice,
}: {
  status: EmailVerificationUiStatus;
  onVerify: () => void;
  sending: boolean;
  notice: { tone: "ok" | "error"; text: string } | null;
}) {
  return (
    <>
      {status === "verified" && (
        <p className="email-verify-line is-verified">
          <ShieldCheck aria-hidden="true" /> Email verified
        </p>
      )}
      {status === "unverified" && (
        <p className="email-verify-line is-unverified">
          <TriangleAlert aria-hidden="true" /> Email not verified
          <button
            type="button"
            className="email-verify-action"
            onClick={onVerify}
            disabled={sending}
          >
            {sending ? "Sending…" : "Verify email"}
          </button>
        </p>
      )}
      {notice && <p className={`email-verify-notice is-${notice.tone}`}>{notice.text}</p>}
    </>
  );
}
