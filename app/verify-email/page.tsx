"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ShieldCheck, TriangleAlert } from "lucide-react";

/**
 * A3 — the landing page an email-verification link opens. It reads the raw
 * token from the query string and POSTs it to
 * /api/auth/email-verification/verify exactly once. No session is required
 * (the token itself is the proof). The token is never rendered or stored.
 */
function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<"working" | "verified" | "error">("working");
  const [message, setMessage] = useState("Confirming your email address…");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!token) {
      setState("error");
      setMessage("This verification link is missing its token. Request a new one from your account page.");
      return;
    }

    (async () => {
      try {
        const res = await fetch("/api/auth/email-verification/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
        if (res.ok && data.status === "verified") {
          setState("verified");
          setMessage("Your email address is verified. You can close this tab and return to TurnitPlus.");
        } else {
          setState("error");
          setMessage(
            typeof data.error === "string" && data.error
              ? data.error
              : "This verification link is invalid or has expired.",
          );
        }
      } catch {
        setState("error");
        setMessage("Something went wrong confirming your email. Please try again.");
      }
    })();
  }, [token]);

  return (
    <main className="verify-email-page">
      <section className="verify-email-card surface-card" aria-live="polite">
        <div className="auth-dialog-brand">
          <div className="brand-mark">T+</div>
          <div>
            <strong>TurnitPlus</strong>
            <span>Email verification</span>
          </div>
        </div>
        <div className={`verify-email-status is-${state}`}>
          {state === "verified" ? (
            <ShieldCheck aria-hidden="true" />
          ) : state === "error" ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <span className="verify-email-spinner" aria-hidden="true" />
          )}
          <h1>
            {state === "verified"
              ? "Email verified"
              : state === "error"
                ? "We couldn't verify this link"
                : "Verifying…"}
          </h1>
        </div>
        <p>{message}</p>
        <a className="button primary" href="/">
          Return to TurnitPlus
        </a>
      </section>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <main className="verify-email-page">
          <section className="verify-email-card surface-card">
            <p>Loading…</p>
          </section>
        </main>
      }
    >
      <VerifyEmailInner />
    </Suspense>
  );
}
